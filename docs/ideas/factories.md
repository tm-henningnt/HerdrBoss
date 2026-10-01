# Herdr Boss factories: research summary, specification and design proposal

Status: proposal for the Owner. Nothing is built.
Author: the Boss, with five research advisors (notes A to E in the same folder) and one independent review (`review-fable.md`). This version includes the review corrections (section 3a).
Scope: run several Herdr Boss "software factories" from Docker images, manage them from one place, and connect to them with Herdr.

## 1. Summary

A factory is one Herdr server, one Herdr Boss service, its projects, its harnesses and its browser. Today the one factory runs natively on the Owner's Mac. This proposal adds four things:

1. A container image that holds a complete factory.
2. A host tool, `herdr-boss factory`, that builds the image, creates a factory from it, walks the Owner through the configuration, and updates it.
3. A connection from the Owner's Herdr to each factory over SSH.
4. A hub view in Herdr Boss that shows all factories in one place.

The Mac factory stays native and becomes "factory zero". Each container factory is independent. A hub failure never affects a factory.

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

- Moving a running project between factories.
- A fleet-wide Boss agent.
- Controlling workers of another factory from the hub.
- Running on a public cloud service.

## 3. Terms

| Term | Meaning |
|---|---|
| Factory | One Herdr server, one Herdr Boss service, its data, projects and harnesses. |
| Factory zero | The current native Mac factory. |
| Hub | The Herdr Boss instance that polls factories and shows the Fleet page. It is the Mac factory in phase 1. |
| Profile | A template for a factory: policy, models, wizard steps, naming. |
| Image | The container image. It holds tools and a seed of the Herdr Boss code. It holds no data and no secret. |

## 3a. Corrections after the independent review

The review found four code facts that break the first draft. Each is verified in the repository. The design below uses the corrected form.

1. **Data directory.** `src/engine.js:551-552` turns off all actions (no prompts, no reaping, no notifications) when the data directory is not the configured live directory. `src/data-dir-guard.js` also treats a custom path as not live, so the migration guard does not protect it. A factory with `HERDR_BOSS_DIR=/data` would be inert. Fix: mount the data volume at `/home/factory/.herdr-boss`, or set `HERDR_BOSS_LIVE_DIR` to the volume path and assert at start that both paths match.
2. **Supervisor.** tini reaps processes and forwards signals. It does not restart a crashed service. Use s6-overlay (or supervisord) with one service for sshd, `herdr server` and `herdr-boss serve`, restart on exit, and a Docker `HEALTHCHECK` on `/api/health`. It replaces launchd `KeepAlive` (`src/cli.js:961-968`).
3. **Cookies and hostnames.** `src/access.js` sets the session cookie `herdr_boss_session` with `Path=/`. A browser does not scope cookies by port, so a login to one factory on `127.0.0.1:<port>` overwrites the cookie of another factory and of factory zero. Give each factory its own hostname (`<name>.localhost` or the tailnet name) and extend `allowedHost` (`src/server.js`) to accept `*.localhost`.
4. **Shared quota.** Quota rows carry no account id (`src/collect.js`). Until the hub computes pace per account (phase 5 and later), run one factory per account, or copy the Mac quota snapshot into each factory as a read-only file. The research notes disagree on CodexBar on Linux: one says macOS only, one says there is a Linux CLI. The spike settles it.

Other corrections: keep host secrets and SSH keys where agents of factory zero cannot read them (section 7); order the Codex sandbox decision after the spike (section 14); build `qlik-cli` from source for arm64 (section 5.2); OrbStack is paid for commercial use, so Colima is the default unless the Owner buys a licence (section 5.1).

## 4. Architecture

```
Owner's Mac
  Herdr (TUI) ----ssh----+---------------------------+
  Browser ---https/ts----|                           |
  herdr-boss (factory zero, native, also the hub)    |
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

Use Docker. On the Mac use Colima by default, or OrbStack if the Owner buys a licence (OrbStack is free for personal use only, so client work needs a paid licence). On Linux use Docker Engine. Colima and OrbStack use the same Docker API, so the image does not change. Podman and Apple's `container` tool are not recommended now.

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
- First image set: Debian, Node, git, gh, Herdr, sshd, Claude Code, Codex CLI, Herdr Boss. Add Chrome, OpenCode, Pi and `qlik-cli` in the next phase. The browser features need a way to sign in to a web app in a headless Chrome (a VNC or CDP screencast route). Until that exists, factories have no browser features.
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
- Registry: local images first. A private GHCR repository when a second host exists. The Dockerfile may be public. The image holds no private data.
- Phase 2 builds `arm64` only. Add `amd64`, SBOM, a vulnerability scan and a weekly CI job when a second host exists. Add a Linux CI run for the Linux readers (the repository has no `.github/workflows` for it today). Keep three tags for rollback.

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

Add a push ping from a factory for urgent Owner items in phase 2. Keep a push mode with the same payload for a factory behind NAT. A mesh is rejected.

### 8.2 What a factory must add

1. `GET /api/fleet/summary`: a small, versioned, allow-listed document (5 to 20 KB). Today `/api/state` is about 370 KB and holds local paths and lock commands.
2. A read-only token scope. Today one token can also write policy and messages.
3. A host rule that accepts per-factory hostnames (`*.localhost`, tailnet names) and container names. Today `allowedHost` refuses both.
4. A stable `factoryId`, a `schema` number, and an `accountKey` (an HMAC of the account identity, never the identity) on quota rows.
5. `GET /api/health`: version, schema, kit revision, tick age, Herdr reachable.

### 8.3 Summary content

Identity and version; health and machine load; projects with phase, status and status age; board counts (Doing, Review, Blocked, Done 7 d); quotas with `accountKey`; spend per day, role, harness; alerts; Owner items (counts, ids, kinds); review packs waiting; the factory's dashboard base URL.

Never leaves a factory: tokens and sessions, cookies, message and chat text, transcripts, attachments, screenshots, local paths, pane output, lock commands, private repository URLs, Claude settings. A test fails when a summary key is not on the allow-list. Item titles go to the hub only when `fleet.shareItemTitles` is on (default off).

### 8.4 Owner views

1. Fleet page: one line per factory with name, version, last seen, status dot, projects needing attention, worst quota lane, spend today and open Owner items. Red or amber rules are defined in `research-D`.
2. Combined Mailbox: Owner items with a factory tag. Phase 1 links to the factory. Phase 2 answers through the factory's own message route. The factory owns the item.
3. Quota view: grouped by `accountKey`. Factories on one account read the same percentage, so the hub does not add them.
4. Spend page: the sum by day, role, harness and factory.
5. Kit and version drift per factory and per project.

One Boss per factory stays. The hub Mailbox gives the Owner one inbox and routes each reply to its source factory. A fleet-level Boss is a later option.

### 8.5 Enrolment and trust

- In the first phases, on one Mac, the host tool creates the read token inside the factory and hands it to the hub. Later, for a second host: `herdr-boss fleet invite NAME` on the hub prints a single-use join token (15 minutes). The factory runs `fleet join <hub-url> <token>`. The hub returns the factory credential. Deliver it as a Docker secret or a 0600 file.
- Separate `fleetRead` and `fleetWrite` credentials. Phase 1 issues read only. Rotation keeps the old token valid for 10 minutes. Revoke on the hub first for a lost factory.
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

The full wizard has 17 steps. The first release implements 8: container, volumes, herdr, service, harness-claude, harness-codex, github, project. Steps 5 (kit), 8 to 9, 11 to 13 and 15 to 17 follow later. A resumable state machine like `project new`. A finished step is skipped when its check still passes. Exit code 3 means waiting for the Owner, either for a Mailbox decision item or for an interactive login at a host terminal. No secret enters the Mailbox.

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

A profile is a folder with `factory.json`, a `policy.json` seed, a `config.json` seed and the required wizard steps. Examples: `client` (approved models, one project, a client org and tenant, updates after canary) and `experiments` (all models, free first, higher worker cap, updates first). Container name `hf-<name>`, volumes `hf-<name>-data|home|work|code`.

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
| 0 | Spike: run Herdr and a worker in a minimal container, test the Codex seccomp profile and CodexBar on Linux (section 12). Then the Owner decides question 1. | half a day |
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
| 1 | Codex in a container: relax the seccomp profile, or let the container be the sandbox (`--dangerously-bypass-approvals-and-sandbox`)? The bypass conflicts with `docs/harness-setup.md:253` and removes the guard that keeps a worker away from the login files on the `home` volume. | Decide after the spike. Test a narrow seccomp profile first. Prefer it to the bypass. |
| 2 | Accounts: may client factories use your subscription, or do they need separate API keys or accounts? | Separate accounts or keys for any client factory. Subscription only for your own factories, a few at a time. |
| 3 | Where does the hub run: the Mac factory, or a container? | The Mac factory (factory zero). |
| 4 | Runtime: client work is commercial, so OrbStack needs a paid licence. | Colima by default, OrbStack if you buy a licence. |
| 5 | May item titles reach the hub, or counts only? | Counts only in phase 1. Titles as a setting. |
| 6 | Registry: private GHCR or local images only? | Private GHCR once there is a second host. Local images first. |
| 7 | May `PRODUCT.md` widen from "all Herdr projects on this machine" to "all factories"? | Yes. |
| 8 | Tool form: `herdr-boss factory` or a separate binary? | `herdr-boss factory`. |
| 9 | `qlik-cli` on arm64 Linux. | Build it from source in a Go build stage. |
| 10 | Network: one tailnet for all factories? | Yes. |

## 15. Sources

Research notes in `~/.herdr-boss/scratch/boss/factories/`: A containers, B authentication, C Herdr connectivity, D fleet aggregation, E lifecycle. The notes list their own sources and mark unverified claims. Unverified items in this proposal: size of the image, Herdr headless behaviour in a container, CodexBar on Linux, OpenAI terms on login sharing, the Claude Linux managed-settings path, the qlik-cli contexts path.
