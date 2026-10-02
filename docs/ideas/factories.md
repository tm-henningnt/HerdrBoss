# Herdr Boss factories: research summary, specification and design proposal

Status: proposal for the Owner, under interview. Nothing is built. Decided points link to ADRs in `docs/adr/` (0002 and later). The glossary is `docs/CONTEXT.md`.
Author: the Boss, with five research advisors (notes A to E in the same folder) and one independent review (`review-fable.md`). Version 2 adds head office succession, users and access, Windows and client-premises hosts, and project transfer (sections 16 to 20). Version 1 text is kept where it still holds. Where sections 16 to 20 differ from sections 1 to 15, sections 16 to 20 win.
Scope: run several Herdr Boss "software factories" from Docker images, manage them from one place, and connect to them with Herdr.

## 1. Summary

A factory is one Herdr server, one Herdr Boss service, its projects, its harnesses and its browser. Today the one factory runs natively on the Owner's Mac. This proposal adds four things:

1. A container image that holds a complete factory.
2. A host tool, `herdr-boss factory`, that builds the image, creates a factory from it, walks the Owner through the configuration, and updates it.
3. A connection from the Owner's Herdr to each factory over SSH.
4. A hub view in Herdr Boss that shows all factories in one place.

The Mac factory may stay native for now. The head office is a role that any factory can hold, so it can move to a home server (section 16). Each factory is independent. A head office failure never stops a factory.

Recommendation in one line: one Debian-based multi-arch image, one container per factory, sshd inside for Herdr, a pulling hub with a small read-only summary route, and a resumable configuration wizard in the style of `project new`.

## 2. Goals and non-goals

Goals:

- Start a new factory with one command and a short, guided configuration.
- Keep the image and the factories up to date without losing work.
- Authenticate the harnesses and services once per factory, with no secret in an image, a repository, a transcript or the Mailbox.
- Attach to any factory with Herdr from the Mac, as to a local session.
- See the state of all factories, the questions that need the Owner, the quota and the spend in one place.
- Run the same code on Linux and macOS.

Non-goals for the first phases:

- Moving a running project between factories without a freeze (a planned transfer is in section 19).
- A fleet-wide Boss agent.
- Controlling workers of another factory from the hub.
- Running on a public cloud service with a public IP address. A cloud VM that is reachable only over the tailnet is allowed as a host (ADR 0009).

## 3. Terms

| Term | Meaning |
|---|---|
| Factory | One Herdr server, one Herdr Boss service, its data, projects and harnesses. |
| Factory zero | The current native Mac factory. |
| Hub or head office | The factory that holds the head office role. It polls factories and shows the Fleet page. The role can move (section 16). |
| Profile | A template for a factory: policy, models, wizard steps, naming. |
| Image | The container image. It holds tools and a seed of the Herdr Boss code. It holds no data and no secret. |

## 3a. Corrections after the independent review

The review found four code facts that break the first draft. Each is verified in the repository. The design below uses the corrected form.

1. **Data directory.** `src/engine.js:551-552` turns off all actions (no prompts, no reaping, no notifications) when the data directory is not the configured live directory. `src/data-dir-guard.js` also treats a custom path as not live, so the migration guard does not protect it. A factory with `HERDR_BOSS_DIR=/data` would be inert. Fix: mount the data volume at `/home/factory/.herdr-boss`, or set `HERDR_BOSS_LIVE_DIR` to the volume path and assert at start that both paths match.
2. **Supervisor.** tini reaps processes and forwards signals. It does not restart a crashed service. Use s6-overlay (or supervisord) with one service for sshd, `herdr server` and `herdr-boss serve`, restart on exit, and a Docker `HEALTHCHECK` on `/api/health`. It replaces launchd `KeepAlive` (`src/cli.js:961-968`).
3. **Cookies and hostnames.** `src/access.js` sets the session cookie `herdr_boss_session` with `Path=/`. A browser does not scope cookies by port, so a login to one factory on `127.0.0.1:<port>` overwrites the cookie of another factory and of factory zero. Give each factory its own hostname (`<name>.localhost` or the tailnet name) and extend `allowedHost` (`src/server.js`) to accept `*.localhost`.
4. **Shared quota.** Quota rows carry no account id (`src/collect.js`). Each account has an account scope, and each factory has a factory share of each shared account. The factory enforces its share locally. The head office sets the shares with a slider and sends guidance to each factory Boss (ADR 0011). The research notes disagree on CodexBar on Linux: one says macOS only, one says there is a Linux CLI. The spike settles it.

Other corrections: keep host secrets and SSH keys where agents of factory zero cannot read them (section 7); order the Codex sandbox decision after the spike (section 14); build `qlik-cli` from source for arm64 (section 5.2); OrbStack is paid for commercial use, so Colima is the default unless the Owner buys a licence (section 5.1).

## 4. Architecture

```
Owner's Mac
  Herdr (TUI) ----ssh----+---------------------------+
  Browser ---https/ts----|                           |
  herdr-boss (factory zero, native; may hold the role) |
  herdr-boss factory ... (host tool, uses Docker)    |
        |  polls GET /api/fleet/summary (read token) |
        v                                            v
  Container factory A                      Container factory B
    tini -> sshd, herdr server, herdr-boss serve     (same image)
    volumes: data, home, work, code
```

Rules:

- One container for one factory. The process table, the loopback ports and the Herdr socket stay in one namespace. The present code expects this.
- A factory talks only to its own Herdr socket. It never uses SSH to reach Herdr.
- The hub reads state over HTTP. It does not parse Herdr output.
- The Owner reaches the terminal of a factory through Herdr over SSH. Herdr never carries fleet data.
- A factory keeps all message text, transcripts, paths and secrets. The hub gets counts, states and links.

## 5. The container image

### 5.1 Runtime

Use Docker. On the Mac use OrbStack without a paid licence. The Mac runs only personal factories, because OrbStack is free for personal use only. Client and commercial factories run on the Owner's Windows host (ADR 0006). Colima is the fallback on the Mac. On Linux use Docker Engine. Colima and OrbStack use the same Docker API, so the image does not change. Podman and Apple's `container` tool are not recommended now.

Keep repositories and worktrees on a named volume inside the Docker VM. A bind mount from macOS is slow for many small files.

Pin OrbStack or Colima updates, and keep the Mac awake on power. A sleep, a reboot or a runtime update stops every factory. Label every volume. Never run `docker volume prune` on a Mac that holds factory volumes.

### 5.2 Contents

- Base `debian:trixie-slim` for both `amd64` and `arm64`. Reason: Alpine breaks procps `ps` and extra packages for Claude Code.
- System: tini, ca-certificates, curl, git, openssh-server, procps, lsof, ripgrep, jq.
- Node 26.10 or newer (`node:sqlite`).
- gh, Herdr (static Linux binary, v0.9.3 has x86_64 and aarch64), Chrome (arm64 Linux builds exist since July 2026).
- The four harnesses: Claude Code, Codex CLI, OpenCode, Pi. Pin every version. Disable self-update in a factory (`DISABLE_UPDATES=1` for Claude Code). A harness update is an image rebuild.
- `qlik-cli`: v3.3.0 has no arm64 Linux build. Build it from source in a Go build stage. Emulation needs Rosetta or qemu on each host.
- Herdr Boss at a pinned commit, as a git checkout (see section 9), with its `.git` directory.
- A non-root user `factory` (UID 1000). s6-overlay is PID 1 with one supervised service each for sshd, `herdr server` and `herdr-boss serve`. Set `TZ` in the image, because the analytics day uses the process time zone. Set a `max-size` on the Docker log driver.
- Git identity, `gh auth setup-git`, GitHub `known_hosts` and the Herdr integration install are part of the image or the wizard.
- First image set: Debian, Node, git, gh, Herdr, sshd, Claude Code, Codex CLI, OpenCode, Chrome, Herdr Boss. Add Pi and `qlik-cli` in the next phase. OpenCode is in the first set because each factory has its own OpenCode subscription (ADR 0007). Chrome is in the first set because a browser sign-in route comes before the first container factory (ADR 0010).
- Code location: the image holds a seed checkout. The run-time checkout is on the `code` volume (section 9.4). A kit update inside a factory changes the volume, not the image.
- Pi must not use a Claude subscription (the vendor terms forbid it). The image defaults enforce this.

Estimated size: 1.2 to 1.8 GB. Not measured.

### 5.3 Volumes (named, per factory)

| Volume | Holds |
|---|---|
| `data` | `~/.herdr-boss` (database, policy, locks, ledgers, backups) |
| `home` | harness logins, `~/.config/herdr`, gh, qlik, browser profiles, caches |
| `work` | repositories and worktrees |
| `code` | the Herdr Boss and kit checkout used at run time |

No Mac home directory, no `~/.config` and no Docker socket is mounted into a factory.

### 5.4 Resources and network

- Compose limits per factory: `cpus`, `mem_limit`, `memswap_limit`, `pids_limit`, and `shm_size: 1g` for Chrome. Start with 4 CPU and 8 GB. On a 24 GB Mac plan two or three factories.
- The machine guard must read cgroup limits, not the host totals.
- Publish the dashboard on `127.0.0.1:<port>:4477`. A published port is not loopback inside the container, so the access token applies. Give each factory its own hostname (section 3a item 3). Publish sshd on `127.0.0.1:<port>:22`. Keep CDP on 127.0.0.1 inside the container and publish nothing for it.
- Remote access by Tailscale on the host. No public port.

### 5.5 Build and update pipeline

- `docker buildx bake` with one `pins.json` for all versions.
- Tags `herdr-factory:<kit-version>-<yyyymmdd>` and a moving `stable`. Pins are OCI labels.
- Registry: none. Each host builds its own image with `factory build` (ADR 0015). The Dockerfile is public. The image holds no private data. `factory status` shows the build date and the pins hash.
- Each host builds for its own CPU type. The first container factory is on an amd64 Windows host (ADR 0013). Add SBOM, a vulnerability scan and a weekly CI job later. Add a Linux CI run for the Linux readers (the repository has no `.github/workflows` for it today). Keep three tags for rollback.

### 5.6 Differences from macOS

| Today on macOS | In a container |
|---|---|
| Codex sandbox refuses the Chromium Mach port (error 1100) | Gone. |
| Chrome `code_sign_clone` leftovers | Gone. |
| Codex bubblewrap sandbox | New problem: it fails under the default Docker seccomp profile. See open question 1. |
| launchd, `launchctl` | Replaced by tini and a Docker restart policy. |
| `sysctl vm.swapusage`, `memory_pressure`, `ioreg` | Need `/proc/meminfo` and `/proc/pressure` readers. |
| Chrome path | Hard-coded in `src/browser-pool.js:410`. Make it a setting. |
| CodexBar quota CLI | Probably macOS only (unconfirmed). Quota reads need another source. |
| `lsof`, `ps -o lstart` | Work with `lsof` and procps installed. |

## 6. Herdr connectivity

Facts from the research:

- Herdr has no TCP port. Its API is JSON on a local Unix socket. All remote use goes over plain OpenSSH: `--remote`, `machine add`, `machine status`, `--machine <label> ...`.
- The remote side needs a `herdr` binary and a running server. The server runs headless and keeps named sessions.
- There is no token and no scoped or read-only access. Control comes from file permissions or an SSH key.

Design:

1. Each factory runs sshd (key-only, no root, no password), published on a unique loopback port. On a remote host, use Tailscale or `ProxyJump`.
2. One SSH key per factory. Add each factory on the Mac with `herdr machine add`. The Herdr sidebar then shows all factories, their agents and attention states in one window.
3. Pin one Herdr version in the image. The `machine` feature needs server capabilities that depend on the version.
4. Agent and pane ids repeat between servers. The hub and the dashboard show them as `factory/pane`.
5. Herdr's `terminal` toast reaches the Mac only while a TUI client is connected. A hub-side notifier covers headless alerts (see section 8).

Facts that need a test in a real container are listed in `research-C` (14 items). The first test is the spike in section 12.

## 7. Authentication and secrets

Facts from the research:

- Claude Code: `claude setup-token` makes a one-year token for `CLAUDE_CODE_OAUTH_TOKEN`. A leftover `ANTHROPIC_API_KEY` overrides the subscription. Headless login also works with a copied URL and a pasted code.
- Codex: `codex login --device-auth` works headless. Rotation of refresh tokens across copies of `auth.json` is unverified.
- OpenCode, gh and `qlik-cli` work with static keys. The Qlik MCP needs a first connection by a tenant administrator, so it cannot be fully automated.
- All containers on one account share one quota pool. Anthropic's terms describe subscription limits as for "ordinary, individual usage" and restrict bots and scripts. Factories that run unattended around the clock on one subscription are a terms risk (open question 2). Hard per-factory budgets need separate API keys or accounts.

Design:

- No credential in an image, a layer, the registry, a repository, a Compose file, the Mailbox, a pane or a report.
- Each factory has its own `home` volume. Host secrets, hub read tokens and SSH keys live in `~/.config/herdr-boss/` (agents must not read it) or the Keychain, not under a path that agents of factory zero can read. Load SSH keys into `ssh-agent` with a confirm prompt. Prefer scoped tokens to login files.
- `factory login NAME HARNESS` runs at a host terminal through `docker exec`, never through the entrypoint, so a device-code URL does not stay in `docker logs`. It shows only the URL or the code, waits, then checks with a harmless call. It prints no token.
- A backup that includes the `home` volume holds credentials. Keep it at mode 0600, outside every repository and every cloud-synced folder, and encrypt it when it leaves the Mac.
- Check that a variable is set with `${VAR:+set}`. Never print a value.
- Add "login expired" to the failure labels. An auth failure pauses only that factory and posts one Owner item with the re-login command.
- The image ships safe defaults for each harness: Claude `autoMode` seed, Codex rules, OpenCode `worker` agent. A profile can override them. The Owner can still change them in a factory.
- The repository is public. Profiles hold no client name, tenant URL or app ID. Those go in per-factory private config. Profiles and test fixtures use placeholders, and `src/secret-scan.js` checks them.

## 8. The hub and the Fleet view

### 8.1 Link model

A pulling hub. The hub polls each factory every 30 seconds with a read-only token over Tailscale or a private Docker network. A hub outage changes nothing in a factory. A factory outage shows as the last good data with its age.

The head office also sends guidance to each factory Boss: factory shares and nudge messages, with the narrow `fleetGuide` credential (ADR 0011). Add a push ping from a factory for urgent Owner items in phase 2. Keep a push mode with the same payload for a factory behind NAT. A mesh is rejected.

### 8.2 What a factory must add

1. `GET /api/fleet/summary`: a small, versioned, allow-listed document (5 to 20 KB). Today `/api/state` is about 370 KB and holds local paths and lock commands.
2. A read-only token scope. Today one token can also write policy and messages.
3. A host rule that accepts per-factory hostnames (`*.localhost`, tailnet names) and container names. Today `allowedHost` refuses both.
4. A stable `factoryId`, a `schema` number, and an `accountKey` (an HMAC of the account identity, never the identity) on quota rows.
5. `GET /api/health`: version, schema, kit revision, tick age, Herdr reachable.
6. `POST /api/fleet/guidance`: factory shares and nudge messages from the head office. Only the `fleetGuide` credential may call it.

### 8.3 Summary content

Identity and version; health and machine load; projects with phase, status and status age; board counts (Doing, Review, Blocked, Done 7 d); quotas with `accountKey`; spend per day, role, harness; alerts; Owner items (counts, ids, kinds); review packs waiting; the factory's dashboard base URL.

Never leaves a factory: tokens and sessions, cookies, message and chat text, transcripts, attachments, screenshots, local paths, pane output, lock commands, private repository URLs, Claude settings. A test fails when a summary key is not on the allow-list. Item titles go to the head office only when `fleet.shareItemTitles` is on. The `personal` profile sets it on, the `client` profile off (ADR 0016).

### 8.4 Owner views

1. Fleet page: one line per factory with name, version, last seen, status dot, projects needing attention, worst quota lane, spend today and open Owner items. Red or amber rules are defined in `research-D`.
2. Combined Mailbox: Owner items with a factory tag. Phase 1 links to the factory. Phase 2 answers through the factory's own message route. The factory owns the item.
3. Quota view: grouped by `accountKey`. Factories on one account read the same percentage, so the head office does not add them. One slider per factory sets its factory share of each shared account (ADR 0011).
4. Spend page: the sum by day, role, harness and factory.
5. Kit and version drift per factory and per project.

One Boss per factory stays. The hub Mailbox gives the Owner one inbox and routes each reply to its source factory. A fleet-level Boss is a later option.

### 8.5 Enrolment and trust

- In the first phases, on one Mac, the host tool creates the read token inside the factory and hands it to the hub. Later, for a second host: `herdr-boss fleet invite NAME` on the hub prints a single-use join token (15 minutes). The factory runs `fleet join <hub-url> <token>`. The hub returns the factory credential. Deliver it as a Docker secret or a 0600 file.
- Separate `fleetRead`, `fleetGuide` and `fleetWrite` credentials. Phase 1 issues `fleetRead` and `fleetGuide` only. Rotation keeps the old token valid for 10 minutes. Revoke on the hub first for a lost factory.
- `factoryId` lives in the data directory. A cloned volume gives a second factory with the same id: the hub refuses it and flags it.
- The schema is add-only. The hub ignores unknown fields and shows "hub older" or "factory older".
- History in the hub database: 5 minute snapshots for 48 hours, hourly for 30 days, daily for a year.

## 9. The factory tool and its lifecycle

### 9.1 Form

`herdr-boss factory ...`, in `src/factory/`, loaded lazily. It runs on the host, outside the containers, because it must repair a container whose service is dead. It imports nothing from `engine.js` and refuses to run inside a container. The alternative, a separate `herdr-factory` binary, has a separate failure domain but duplicates the flow engine and redaction (open question 8). Recommendation: the first form.

Host files: `~/.herdr-factories/registry.json` (no secrets); per factory `factory.json` and `flow.json`. Secrets and keys are stored as in section 7. The host tool runs from Mac `main` and a factory runs a pinned commit, so each host tool release states a minimum factory version.

### 9.2 Commands

| Command | Action |
|---|---|
| `factory new NAME --profile P` | Write config, create volumes, pull or build the image, create the container. |
| `factory build [--push]` | Build the image from `pins.json`. |
| `factory start`, `stop [--now]` | Start, or quiesce and stop. |
| `factory status [NAME]` | Container, health, schema, kit revision, workers, quota, disk. |
| `factory configure NAME [--resume] [--step S]` | The wizard. |
| `factory login NAME HARNESS` | Harness login at a host terminal. |
| `factory update NAME [--tier service\|image] [--canary] [--dry-run]` | Updates. |
| `factory rollback`, `backup`, `restore FILE`, `destroy` | Recovery. Destroy needs a fresh backup and a typed confirmation. |
| `factory list`, `connect NAME --hub URL`, `shell`, `logs`, `freeze` | Overview, fleet link and break glass. |

### 9.3 The wizard

The full wizard has 17 steps. The first release implements 9: container, volumes, herdr, service, harness-claude, harness-codex, harness-other (OpenCode), github, project. Steps 5 (kit), 8 to 9, 11 to 13 and 15 to 17 follow later. A resumable state machine like `project new`. A finished step is skipped when its check still passes. Exit code 3 means waiting for the Owner, either for a Mailbox decision item or for an interactive login at a host terminal. No secret enters the Mailbox.

| # | Step | Check |
|---|---|---|
| 1 | container | running and healthy |
| 2 | volumes | writable data, home and work |
| 3 | herdr | the Herdr CLI answers in the container |
| 4 | service | `/api/state` returns 200 within 30 s |
| 5 | kit | kit path resolves and the revision matches |
| 6 | harness-claude | logged in (login step) |
| 7 | harness-codex | logged in, live check passes (login step) |
| 8 | harness-other | OpenCode and Pi present if the profile lists them |
| 9 | harness-sync | `harness check` exits 0 (Owner adds Claude `autoMode` lines) |
| 10 | github | `gh auth status` for the profile org |
| 11 | qlik | tenant URL set, a read call succeeds |
| 12 | policy | policy equals the profile template, shares total 100 |
| 13 | quota | `lanes` shows each provider without error |
| 14 | project | `project new`, then `project check` exits 0 |
| 15 | dashboard | the published port answers with the token |
| 16 | hub | the hub reads the factory |
| 17 | handover | `handoff plan` works, `prepare` and `cancel` leave no pane (off by default) |

### 9.4 Updates

| Part | Lives in | How it updates |
|---|---|---|
| OS, Node, git, gh, tools | image | New tag, recreate the container on the same volumes. |
| Harness binaries and Herdr | image, pinned | Rebuild. Self-update off. |
| Herdr Boss code and kit | git checkout on the `code` volume | Tier 1: `git fetch`, `merge --ff-only`, restart the supervised service. Panes survive. |

Window rules: refuse while a worker is working, a suite or push holds the lock, or a handover is prepared. Tier 2 (image swap) kills all panes and a handover cannot cross it: quiesce first (orchestrators publish and commit `memory.md`, workers stop, backup runs), swap, then start fresh orchestrators that read `memory.md`.

Migration safety: take `store.backup` before each update. The migration guard needs `.git` in the checkout. Old code refuses a newer schema, so a rollback after a migration restores the backup and loses later data (`--accept-data-loss`). After restart require `/api/state` 200 within 30 s and one clean tick, or roll back. Write the manual update and rollback procedure first. Automate a canary factory (updates first, promotes after 24 hours) later.

### 9.5 Profiles

A profile is a folder with `factory.json`, a `policy.json` seed, a `config.json` seed and the required wizard steps. Examples: `client` (approved models, one project, a client org and tenant, separate accounts, updates after canary) and `personal` (all models, free first, higher worker cap, the Owner's subscriptions, updates first). The first container factory uses `personal` (ADR 0005). The host tool refuses a `client` profile on a host whose runtime is personal-use only (ADR 0006). Container name `hf-<name>`, volumes `hf-<name>-data|home|work|code`.

### 9.6 Operations

Logs go to stdout and to `server.log` with rotation. Health uses `/api/health` and a Docker `HEALTHCHECK`. Backups cover the database (`VACUUM INTO`), data files and the repositories volume (unpushed branches live there). Break glass without a live service: `factory shell`, `stop --now`, `freeze`.

## 10. Changes to the Herdr Boss repository

| Area | Change |
|---|---|
| Paths | Make worktree and project roots configurable. Run with `HOME=/home/factory`. Mount the data volume at `/home/factory/.herdr-boss`, or set `HERDR_BOSS_LIVE_DIR` and assert that both paths match (section 3a item 1). |
| Service start | Keep launchd for native. Add s6 service definitions for the image. `install` fails clearly off macOS. |
| macOS calls | `/proc` memory and pressure readers. A clock offset check in `/api/health`. Chrome path and flags as settings. Browser optional per profile. A cgroup-aware CPU and memory reader. |
| Process tools | Install `lsof` and procps. Add a start-up check. Guard `src/kit/workers.js:184`. |
| Sandbox | Per-profile Codex launch flags. |
| Network | `allowedHosts` setting. Publish the dashboard on loopback of the Docker host. |
| Fleet | Summary and health routes, read scope, `factoryId`, `accountKey`, hub poller, Fleet page, `fleet invite|join|rotate|revoke`. |
| Quota | A Linux source for quota readings, because CodexBar probably is macOS only. |
| New | `factory/Dockerfile`, `pins.json`, `profiles/*`, `src/factory/*`, tests. |
| Docs | `docs/cli.md`, `docs/user-guide.md`, the dashboard `HELP`, `AGENTS.md`. `PRODUCT.md` scope needs an Owner decision (open question 7). |

## 11. Phases and effort

| Phase | Work | Size |
|---|---|---|
| 0 | Spike on the Mac with OrbStack (ADR 0006): run Herdr and a worker in a minimal container, test the Codex seccomp profile and CodexBar on Linux (section 12). Codex in containers needs the narrow profile (ADR 0008). | half a day |
| 1 | Portability: Linux paths and readers, `allowedHosts`, `/api/health`, stdout log and rotation. | 2 medium, 2 small |
| 2 | Image: Dockerfile, pins, supervisor, `.git` checkout, start-and-migrate smoke test. | 1 large, 1 medium |
| 3 | Tool core: registry, `new build start stop status list`. | 1 large, 1 medium |
| 4 | Wizard: 17 steps, `login`, Mailbox waits, `check`. | 1 large, 2 medium |
| 5 | Fleet phase 1: summary route, read token, hub poller, Fleet page, quota by account. | 1 large, 1 medium |
| 6 | Update: tiers, window rules, dry run, rollback, canary. | 1 large, 1 medium |
| 7 | Backup, restore, destroy, break glass. | 1 medium, 2 small |
| 8 | Fleet phase 2: item titles, combined Mailbox, push ping, review list, answer routing. | 1 large, 1 medium |
| 9 | Fleet phase 3: ceilings with a time limit, policy push, global Watch. | 1 large |

Docs are written in each phase. Exit test for phases 1 and 2: `/api/state` returns 200 and a worker starts in a Linux container. Create the first `client` factory only after one canary update and one restore test pass.

## 12. Spike plan (phase 0)

Run once, by one worker, with the Owner's approval of the runtime:

1. Build a minimal image: Debian, tini, git, sshd, Herdr, Node, Herdr Boss checkout.
2. Start `herdr server` without a TTY. Create a session. Attach by `herdr --remote` over a published loopback sshd port. Attach by `docker exec`.
3. Restart the container. Check that Herdr restores the session layout.
4. Start `herdr-boss serve`. Check `/api/state` and the migration guard.
5. Run one Codex and one Claude worker pane (login by token). Check agent detection.
6. Test the 14 facts in `research-C`. Test Codex with a seccomp profile that allows user namespaces. Test CodexBar on Linux. Test the dashboard login of two factories under two hostnames.
7. Measure `git status` and `npm test` on a named volume against the Mac.

Result: a short report with measured numbers and the changes that the code needs.

## 13. Risks

1. Harness logins and the vendor terms. Subscriptions are not designed for several unattended factories (question 2).
2. The Codex sandbox in Docker (question 1).
3. One shared quota pool per account. Per-factory pacing is wrong without the `accountKey` and a ceiling from the hub.
4. An image swap kills panes. Quiesce and `memory.md` carry the work over.
5. A rollback after a migration loses data.
6. `--no-sandbox` Chrome weakens isolation. Never mount the Docker socket or the Mac home.
7. A hub with write scope reaches every factory. Keep write off in the first phases.
8. The public repository must hold no client data.
9. Herdr has no scoped tokens. An SSH key gives full control of one factory.

## 14. Decisions for the Owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Codex in a container: relax the seccomp profile, or let the container be the sandbox (`--dangerously-bypass-approvals-and-sandbox`)? The bypass conflicts with `docs/harness-setup.md:253` and removes the guard that keeps a worker away from the login files on the `home` volume. | Decide after the spike. Test a narrow seccomp profile first. Prefer it to the bypass. **Decided: ADR 0008.** |
| 2 | Accounts: may client factories use your subscription, or do they need separate API keys or accounts? | Separate accounts or keys for any client factory. Subscription only for your own factories, a few at a time. **Decided: ADR 0007.** |
| 3 | Where does the hub (head office) run? | Superseded by section 16: it is a role. Start on an always-on box at home, with a cold standby. **Decided: factory zero first, ADR 0009.** |
| 4 | Runtime: client work is commercial, so OrbStack needs a paid licence. | Colima by default, OrbStack if you buy a licence. **Decided: OrbStack, personal use on the Mac; client work on the Windows host, ADR 0006.** |
| 5 | May item titles reach the hub, or counts only? | Counts only in phase 1. Titles as a setting. **Decided: per factory, on for personal, ADR 0016.** |
| 6 | Registry: private GHCR or local images only? | Private GHCR once there is a second host. Local images first. **Decided: each host builds, ADR 0015.** |
| 7 | May `PRODUCT.md` widen from "all Herdr projects on this machine" to "all factories"? | Yes. **Decided: ADR 0004.** |
| 8 | Tool form: `herdr-boss factory` or a separate binary? | `herdr-boss factory`. **Decided: ADR 0002.** |
| 9 | `qlik-cli` on arm64 Linux. | Build it from source in a Go build stage. **Decided: ADR 0003.** |
| 10 | Network: one tailnet for all factories? | Yes. **Decided: one tailnet with tags and access rules, ADR 0017.** |


## 16. Head office as a role, handover and succession (version 2)

Requirement: the head office may run on any factory, even a home server. The Owner can move it. If it goes offline, the online factories agree on a temporary head office.

### 16.1 What the head office holds

The role record (who is head office, epoch, ranked succession list), the factory registry, access lists and trusted keys, policy, Mailbox reply state and enrolment tokens. A signed, encrypted SQLite snapshot of 1 to 20 MB covers it (estimate, not measured). Each factory owns its own items, history and state. A successor rebuilds the fleet view by polling.

### 16.2 Replication

- Phase 1: a snapshot to the cold standby on each change and every hour. A standby is a factory of the Owner on an always-on host. A client-premises factory is never a standby and never receives a snapshot, because the snapshot holds the registry and access lists of all factories. A host that sleeps (a Windows box without a service setup) cannot be a standby.
- Phase 2: an add-only change log shipped to every factory on the succession list.
- Not used: Litestream, LiteFS (poor fit), rqlite and Raft (heavy, and they break the no-dependency rule).

### 16.3 Election

A ranked succession list set by the Owner, plus a time-limited lease and a fencing epoch.

- The highest-ranked online factory claims the role when the lease of the current head office has expired and it cannot reach the head office for N missed polls.
- Every grant, token and message carries the epoch. A factory ignores anything with a lower epoch.
- An epoch alone does not stop two head offices: in a network split each side can mint the same next epoch. Three rules close the gap. First, a claim is valid only when the claimant is on the Owner-signed list, its epoch is the last known epoch plus one, and its rank beats every holder it still sees. Second, a holder stops acting when its lease expires on a monotonic clock (not the wall clock), and a sleeping holder that wakes with an old lease first checks the list before it acts. Third, a clock offset above 60 seconds blocks a claim. A split can still give two temporary head offices of equal epoch. This is harmless because the temporary role cannot change policy, credentials or enrolment (section 16.4).
- In phase 1 there is no automatic election. The epoch is kept for the manual `hub promote`.
- It works with 2 or more factories and with the Owner offline. Raft needs a quorum and gives no failover with 2.
- Optional single-winner arbiter: a conditional write on an object store.

### 16.4 What a temporary head office may do

It may show the fleet view and relay Mailbox items. It may not change policy, enrol factories, issue credentials or spend, until the Owner confirms. When the preferred head office returns, it takes the role back after a delta sync. Conflicts are merged by epoch and time. The Owner sees every temporary period in the audit log.

### 16.5 Planned move

The move follows the orchestrator handover states: plan, prepare, ready, freeze, delta, Owner-confirmed activate, switch pointer, resume, cancel. A signed owner anchor key authorizes it. The old head office becomes a standby.

### 16.6 Discovery

Each factory keeps a pointer to the head office. A signed discovery record at a stable name (a DNS name or a file in a private repository) tells new factories and the Owner's devices where the role is. A factory follows the highest signed epoch.

### 16.7 Security

Only a factory on the succession list may claim the role. Heartbeats are signed. A factory that lies about its state can only hurt itself, because the head office reads summaries and does not trust them for access. A stolen factory is revoked on the head office first, by key.

### 16.7a Trust model

- One key pair for each factory. The private key never leaves the factory.
- The Owner holds an anchor key. The Owner-signed succession list binds each rank to a factory key id. The list is the trust root.
- A factory accepts head office signatures only from the key of the current epoch holder on the list. The snapshot holds public keys and the list. It never holds private keys.
- Enrolment tokens are not replicated: a successor cannot enrol new factories until the Owner confirms.
- Anchor key custody: kept offline by the Owner (for example a hardware key or a sealed file). If the anchor key is lost, the Owner creates a new anchor and re-enrols every factory by hand. State this in the runbook.

### 16.7b Runbook: a stolen or lost factory

1. Remove the factory from the succession list (signed by the anchor).
2. Revoke its key and all grants. Cached grants expire in at most 72 hours, so also push a revocation list.
3. Rotate the read token of every factory it could reach.
4. Revoke harness tokens (Claude, Codex, OpenCode), the `gh` login and the tenant keys at the vendor.
5. Tell the client if it was a client factory. Check the audit chain for the time before the loss.

### 16.8 Phase 1 and later

Phase 1: one head office, one cold standby with a snapshot, the epoch, and a manual `hub promote`. Later: the change log, then the automatic election with the rules of section 16.3 and the temporary role limits.

## 17. Users, roles and access (version 2)

Requirement: users and roles. Not every user may reach every factory. A client user may have view rights only, on the client's own factory, directly and not through the head office. The Owner has his own and some client factories. A colleague has another set.

### 17.1 Facts in the code

Today there is one token with all rights and a loopback bypass (`src/access.js:50-53`, `src/server.js:341`). Agents on loopback can call every route. The review route `/review-raw/` runs before login, and `--read-only-preview` still serves `/api/state` with paths. The 636 KB `public/app.js` holds every route and the help text.

Therefore the client viewer is a separate process. It has its own handler, cookie, sessions and page. It imports nothing from `server.js`, never calls `access.authorized`, accepts only the client hostname (also behind a client reverse proxy that forwards to 127.0.0.1), and answers 404 for everything it does not list. A test asserts 404 for every `server.js` route on the viewer port. It uses an allow-list serializer, and every listed route maps to one permission.

### 17.2 Model

- Fixed roles: owner, operator, reviewer, viewer, service. Grants are user, role, scope (factory, optionally project), stored locally.
- Each factory is the authority for its own access list, so a client factory works with no head office.
- The head office adds signed grants (Ed25519, short expiry) for the factories that trust its key. A factory also keeps local users. An offline owner anchor key authorizes a head office move.
- A client's direct view needs no head office. The head office cannot read it unless the client grants it.

### 17.3 Permission matrix (summary)

| Action | viewer | reviewer | operator | owner | service |
|---|---|---|---|---|---|
| Read state, boards, packs | yes | yes | yes | yes | summary only |
| Read Owner items addressed to the user | yes | yes | yes | yes | no |
| Answer an item or a review pack | no | yes | yes | yes | no |
| Start, stop or nudge workers | no | no | yes | yes | no |
| Change policy | no | no | no | yes | no |
| Manage users and enrol factories | no | no | no | yes | no |
| View spend and quota | no | no | yes | yes | summary |
| Transcripts, paths, pane output, secrets | no | no | no | yes | no |

Note: Herdr access over SSH is owner-level control of a factory (section 13 item 9). It is outside this matrix. Give the SSH key only to owners, and log each session.

### 17.4 Login

In phase 1 the credential scheme is local per-user tokens with a role and a factory list. The head office read token and the signed grants come with later phases. Then passkeys (WebAuthn). Then single sign-on (OIDC) for client users who have it. Between factories and the head office: short-lived signed tokens plus network access lists (Tailscale).

### 17.5 What a viewer must never see

Agent transcripts, pane output, local paths, spend, other projects, settings, tokens, message text of other users. Review packs and items addressed to the viewer are visible. The serializer is an allow-list.

### 17.6 Audit

A hash-chained, append-only table: who did what, when, and from where (the address truncated; the retention period defined per factory). A daily witness of the chain head is stored at the head office. Revocation removes grants and sessions at once. Offboarding a user removes all grants in one command.

### 17.7 Phases

G1 named tokens with a role and a factory list, the viewer listener and the audit log. G2 signed grants from the head office. G3 passkeys. G4 single sign-on.

## 18. Hosts, remote management and client premises (version 2)

Requirement: Linux containers on Docker Desktop or Portainer on Windows, on a home server, in the cloud and on client premises with the client's compute. The Owner's own local factory may also be a container. The Mac stops being special.

### 18.1 Transports

The host tool treats each host as a transport in the registry: `local`, `ssh` (Docker over SSH with a Docker context), `portainer`, `agent`. The wizard and the update logic stay in the host tool. Phase H1 supports `local` and `ssh`. The factory commands do not change.

### 18.2 Windows hosts

- Use Docker Engine in a WSL2 distribution with systemd, started at boot by a scheduled task (ADR 0014). It needs no Docker Desktop licence.
- Keep all volumes named and inside the Linux file system. A bind mount of a Windows folder is slow and loses permissions and file events. Never bind-mount `home` or `data`.
- Set memory and CPU in `.wslconfig`. A reboot, a sleep or a Windows update stops factories: the head office shows "last seen" and alerts.
- The Linux image runs unchanged. Add an `amd64` build before the first Windows or cloud host. Whether the Codex sandbox works in WSL2 with a narrow seccomp profile is an open test.

### 18.3 Portainer

Portainer is optional. It manages containers, not factories. Deploy the same Compose file as a stack where the Owner or a client already runs Portainer. Do not depend on its API for the update logic. The Edge Agent dials out (standard mode uses port 8000 and dials in to the Portainer server; the asynchronous mode needs the Business Edition). The Portainer API key is a root-equivalent secret.

### 18.4 Client-premises factory

- Connection: the factory pushes its summary to the head office over HTTPS on port 443, and keeps a reverse SSH forward (or the client's VPN) for Herdr and for `docker exec` by the host tool. No inbound port at the client.
- Test a TLS inspection proxy before the contract. Support the client's own CA and proxy settings.
- Data: client code and data stay on the client's compute. The head office sees counts, states and links only. Model vendors still receive prompts and code: the contract must allow it (not legal advice; check it).
- Updates: a registry mirror at the client, or a signed offline bundle.
- Accounts: use the client's own accounts and keys for harnesses, GitHub and the Qlik tenant.
- Access: the head office has write scope off for client sites. A client user gets the viewer role on their own factory directly (section 17).
- Herdr over the reverse forward shows client code on the Owner's screen with no audit unless it is logged. Name it in the contract and log each session.
- Client users stay local to the client factory. `fleet.shareItemTitles` is a per-factory setting, default off. A data processing agreement may be needed.
- Client IT questions: Tailscale, reverse SSH or only a client VPN? Who patches the host OS and Docker, in what window?

### 18.5 The local factory in a container

Move the Owner's own factory into a container too. Stay on the host: signed-in GUI Chrome profiles, the Owner's `~/.claude` and `~/.codex`, and the Boss pane while it runs natively. Migration: build the container factory beside the native one, move one project by transfer (section 19), then the rest, then retire the native service.

### 18.6 Remote Herdr

Attach from a Mac or a Windows client with OpenSSH. One key per factory. On a client site, Herdr goes through the reverse forward.

### 18.7 Phases

H0 spike with the Docker context over SSH. H1 `local` and `ssh` transports. H2 Windows host setup (Engine in WSL2) and the amd64 image. H3 the client-site push and reverse forward. H4 offline update bundle. H5 optional Portainer stacks. H6 an in-host agent for sites with no usable inbound path.

## 19. Project transfer between factories (version 2)

Requirement: move a project from one factory to another, through GitHub and a handover like the orchestrator handover.

### 19.1 Steps

1. Plan: `herdr-boss project transfer plan SLUG --to FACTORY` checks that the target exists, has a matching kit version, enough quota and an access list that fits, and that the repository is on GitHub. A Qlik project also needs a tenant administrator at the target.
2. Lock and freeze: create a transfer id. Both factories then refuse `worker start` for the project (a lock file named for the transfer id, on `herdr/transfer-<id>`). The source orchestrator publishes its status and commits `memory.md`. Workers finish or stop. The source closes its orchestrator pane at the end of the freeze.
3. Push: every branch and every worktree with unpushed work goes to GitHub. The transfer branch holds the state files that live in the repository (`memory.md`, briefs, status).
4. Export: a small bundle of the project record, board, ledger entries and kit revision, encrypted to the target factory key. Owner items, review packs and message text stay at the source. The target gets a pointer, not the text.
5. Import on the target: clone from GitHub, apply the bundle, run `kit install`, create the project record and the access grants, and ask for secrets again in the wizard.
6. Start: a fresh orchestrator on the target reads `memory.md`, as in a normal handover. It runs `project check` and publishes its status. Only now may it start workers.
7. Switch: the target proves a clean build. The Owner confirms. The source marks the project `transferred` and parks it. Before the switch, `project transfer cancel` removes the target project, the clone and the grants, lifts the lock, and returns control to the source.

### 19.2 Rules

- Secrets, tenant logins and harness logins never move.
- Tenant apps and spaces belong to a tenant, not a factory: the target needs its own tenant access first.
- Unpushed work blocks the freeze. List it and stop.
- The access list of the project moves with it. Client viewers are re-granted on the target.
- Quota: the target's shares change. The plan shows the effect.
- Only one orchestrator owns the repository at any time: the source pane is closed before the target orchestrator starts.
- Client factories are not a transfer source or target unless the Owner and the client agree in writing.
- The transfer leaves an audit entry on both factories.

## 20. Version 2 phases, decisions and open questions

### 20.1 Revised order

The first plan is the spec `docs/specs/factories.md` with the tickets in `docs/tickets/factories/` (ADR 0021). It covers the personal fleet. The list below stays as the order of the full proposal.

1. Spike (section 12) plus the Docker context over SSH test. Test the viewer process: a 404 for every route.
2. Phases 1 and 2: Linux portability and the image (section 11), with the corrections of section 3a.
3. Tool core, wizard (8 steps) and the transports `local` and `ssh`.
4. Access G1: named tokens, roles, viewer listener, audit log. This is needed before the first client factory.
5. Fleet phase 1 and the head office role with the epoch, a cold standby and a manual `hub promote`. The host tool stays on the Mac.
6. Project transfer in its small form (push, `project new` on the target, copy `memory.md`, transfer lock, cancel) and the local factory in a container.
7. The amd64 image (before the first home server or Windows host). Windows hosts with Docker Engine in WSL2. Client-site push and the reverse forward.
8. Later, only when needed: automatic election, signed grants from the head office, passkeys and single sign-on, the full transfer bundle, Portainer stacks, the in-host agent, the offline update bundle.

### 20.2 New decisions for the Owner

| # | Question | Recommendation |
|---|---|---|
| 11 | Head office: where does it live first? | An always-on box at home, with the Mac as the cold standby if the Mac is awake. A host that sleeps cannot be a standby. **Decided: factory zero until a second host exists, ADR 0009.** |
| 12 | Succession: who is on the ranked list, and may a temporary head office read item titles? | The home box, then one cloud or Windows factory. Counts only until you confirm. **Decided: manual `hub promote` first, ADR 0022.** |
| 13 | Roles and the first users: owner, operator, reviewer, viewer. Who is the first colleague and which factories? | Fixed roles. Decide the first user set when G1 starts. **Deferred to a later spec, ADR 0021.** |
| 14 | Client sites: Tailscale, reverse SSH or only the client's VPN? | Reverse SSH over 443 plus the client's own VPN if required. Ask the client IT early. |
| 15 | Windows hosts: Docker Engine in WSL2 for unattended boxes, Docker Desktop only with a paid licence? | Yes. **Decided: Docker Engine in WSL2, ADR 0014.** |
| 16 | Portainer: optional only? | Yes. The host tool is the factory-aware layer. |
| 17 | Contract: may client code and prompts reach the model vendors? | Check with the client before the first client factory. |

### 20.3 Open tests

Herdr client on Windows and the Herdr server in WSL2. Codex sandbox in WSL2 with a narrow seccomp profile. The election with a split network (fake network test). Reverse SSH through a TLS inspection proxy. The viewer listener: a test that no route leaks.

## 21. Sources

Research notes in `~/.herdr-boss/scratch/boss/factories/`: A containers, B authentication, C Herdr connectivity, D fleet aggregation, E lifecycle, F succession, G identity and access, H hosts and client premises. The notes list their own sources and mark unverified claims. Unverified items in this proposal: size of the image, Herdr headless behaviour in a container, CodexBar on Linux, OpenAI terms on login sharing, the Claude Linux managed-settings path, the qlik-cli contexts path.
