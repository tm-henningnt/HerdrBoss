# Service reference

## Requirements

Use Node.js 26.10 or later. Herdr Boss uses the built-in `node:sqlite` module.

## How it works

Every 30 seconds, Herdr Boss reads Herdr workspaces and agents, machine load and memory, and automation browsers and their owner panes. Every 5 minutes, it reads subscription quotas with `codexbar usage --format json`.

The quota read runs beside the 30-second cycle. A slow `codexbar` does not delay the other reads. A later cycle applies the result. Only one quota read runs at a time. Herdr Boss probes each provider in sequence with `codexbar usage --format json --provider NAME`.

The Claude probe starts with a 60-second timeout. After a failed reading, the next Claude probe uses 90 seconds. A good reading resets its timeout to 60 seconds. Codex and OpenCode Go use timeouts of 20, 45, then 90 seconds after repeated failures. A good reading resets their timeout to 20 seconds.

On timeout, Herdr Boss sends SIGTERM to the probe child by PID and to its own process group. It gives the child three seconds to exit. It then sends SIGKILL if the child remains. It also stops children in that group when the probe child exits. It never selects a process by name. Herdr Boss does not retry a timed-out probe at once.

After the Claude probe times out twice in a row, Herdr Boss probes Claude every 20 minutes. After a good reading, it probes at the normal quota interval again. The policy keys are `quotaProbe.backoffAfterTimeouts` and `quotaProbe.backoffMinutes`. Set them in Settings, in the group Provider quotas. The last good Claude reading stays on the card with its age during the back-off.

If the probe times out at about 30 seconds, check the Claude usage source in CodexBar. See [Harness setup](../harness-setup.md).

When a quota read fails, Herdr Boss keeps the last good quotas. The error text names the provider and the cause:

- `Claude usage probe timed out after 90 s`: the probe exceeded its timeout.
- `Claude usage probe exited with code N`: the probe failed. The text adds the first line of its error output when there is one.

A missing usage reader or login is not a failure. The reading is unknown, and the row carries the reason:

- `no usage reader in this factory`: the probe command is not installed. A container factory has no CodexBar on Linux. The Codex reader replaces CodexBar there and gives its own reasons, listed in `docs/cli.md`.
- `no login for this harness in this factory`: the harness has no login.

OpenCode Go has no usage source. In a factory its row is unknown with the reason `no usage reader in this factory`. The row carries `resetAt` from the setting `quota.opencodeGoResetAt` and `estimate` from `opencode stats --models --days N` (`quota.opencodeStatsDays`). The estimate has `days`, `tokens`, `costUsd`, and `omittedModels`. It is labeled `used in this factory (local estimate)`, and it is never a percent.

A Codex rate limit, a backend error, a timeout, and a changed protocol (`codex app-server protocol changed`) are probe failures. The row keeps the last good reading as stale.

This state raises no Boss warning, no provider back-off, and no fleet alert. The bulletin says "Usage limits are unknown for Claude (no usage reader in this factory). Not a probe failure." The provider card, the lane, and the Boss node show the reason. If the Claude probe fails for over 60 minutes, Herdr Boss sends one warning to the Boss. A missing reader never starts that warning.

`codexbar` can exit with code 1 and still return a good provider row. Herdr Boss keeps that row. A Claude timeout starts the back-off. Other errors wait for the next quota interval. The service keeps the last 100 probe attempts in `quota-probe-history.jsonl`. Each row records the provider, duration, timeout, outcome, ended step, killed PID and PID state, and kill signal. The outcome is `success`, `timeout`, `failed`, or `unavailable`. A missing usage reader or login records `unavailable`. The file does not store probe error text.

When a probe fails, Herdr Boss keeps the last good row of that provider and adds the new error. The bulletin quota table shows the row as "Claude quota from HH:MM (probe failed)". The rules line is "Quota data for Claude is from HH:MM; the last probe failed." The dashboard shows the same text on the provider card. Pacing, quota notices, and provider lanes use the last good row as data. Automatic handover does not use it after a failed probe. The reading becomes stale after three hours, but it stays available. Without a last good row, the bulletin says "Quota data unavailable for Claude". A reading that is unknown, because the reader or the login is absent, says "Usage limits are unknown for Claude" with the reason instead.

At start, Herdr Boss loads the saved quotas from `state.json` when they are younger than 15 minutes. The dashboard shows "Quotas from HH:MM" for these saved quotas until the first new read succeeds. Automatic handover does not use saved quotas.

Then it applies its rules and writes these files to `~/.herdr-boss/`:

| File | Content |
|---|---|
| `bulletin.md` | The rules that orchestrators must obey now. Orchestrators read it before each dispatch. |
| `rules.json` | The same rules for scripts. `worker start` reads it. |
| `state.json` | The full snapshot that the dashboard shows. |
| `events.jsonl` | Prompts, notifications, handovers, and stopped processes. |
| `policy.json` | The resource policy that you set on the Settings and Allocation pages. |
| `policy-changes.jsonl` | The change log of policy writes. One line for each write that changes a value. Keeps the last 500 lines and at most 256 KB. Mode `0600`. See [Policy changes](settings.md#policy-changes). |
| `locks/` | Private project lock records. Each Git repository has a separate directory. |
| `lock-ledger.jsonl` | The lock ledger. One line for each lock acquire, release, and failed acquire. Rotates at 5 MB to `lock-ledger.1.jsonl`. |

`herdr-boss scratch <slug>` creates `~/.herdr-boss/scratch/<slug>/` for the orchestrator files of a project. Herdr Boss does not delete this folder.

Herdr Boss is a script. It uses no LLM and no tokens.

## Dashboard preview

A read-only preview binds `127.0.0.1` and accepts loopback requests only. The option `--host <address>` sets another bind address. Use it only with `--read-only-preview`. The main service is not affected: it keeps the configured `host`. It has no login page. It never reads, creates, or changes token or session files.

Put seed data only into a temporary data directory. Never write seed data or test data into `~/.herdr-boss`. Run the preview with `--read-only-preview` on its own port. `scripts/seed-preview.js` writes invented Mailbox and Chat messages into `HERDR_BOSS_DIR`. It refuses the live data directory, a directory inside it, and a symlink to it, with the message `Refusing to write test data into the live data dir.` Each seed or fixture helper calls `assertTempDataDir(dir)` from `src/data-dir-guard.js` before it writes. `openMessageStore` takes an options object such as `{ dir }`. It throws a `TypeError` for a string.

## Data directory and roots

The service starts only when the configured data directory and live data directory match after path normalization. The live data directory is always `~/.herdr-boss`. `HERDR_BOSS_DIR` selects the data directory. A mismatch stops the service before it writes a file or creates the engine. Two different paths to the same directory do not pass the check. This is the same rule that enables engine actions. Use `--read-only-preview` and a separate temporary directory for a preview.

Open **Settings → Advanced → Service settings**. Find the **Paths** group. Set `worktreeRoot` and `projectRoot`, then select **Save**. Use an absolute path or a path that starts with `~`. A root must not contain a `..` segment and must not be `/`. The defaults are `~/Projects/.herdr-wt` and `~/Projects`.

Set `chromePath` in **Settings → Advanced → Service settings → Browsers**. It is the Chrome executable that Herdr Boss starts for a project browser. The default is the macOS path `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. The rules are the same as for the roots: an absolute path or a path that starts with `~`, and no `..` segment. A running browser uses the new path after its next restart.

`worktreeRoot` is the parent folder for new worker worktrees. A project `worktreeRoot` in `.herdr-boss.json` takes precedence for its workers. Leases, harness checks, and log attribution use the service root. Run `herdr-boss harness sync` after a worktree root change. Existing worktrees stay in place.

`projectRoot` supplies the suggested group folder for **New project** in the dashboard. An entered group or exact path takes precedence. The CLI still requires `--group` or `--path`. Existing projects stay in place.

## Configuration

Put overrides in `~/.herdr-boss/config.json`, then restart the service.

```json
{
  "port": 4477,
  "host": "0.0.0.0",
  "push": true,
  "access": { "tokenFile": "/path/to/private/access-token", "sessionDays": 30 },
  "quota": { "warnPercent": 90, "criticalPercent": 98 },
  "machine": { "memFreeWarnPercent": 15, "loadWarnFactor": 2 },
  "browsers": { "reapOrphanDaemons": true, "orphanDaemonMinAgeSeconds": 7200, "staleOwnedMinutes": 30, "sweepCodeSignClones": true },
  "browser": { "idleCloseMinutes": 20 },
  "workers": { "staleIdleMinutes": 120, "paneCloseDelayMinutes": 2, "uncollectedNoticeMinutes": 30, "autoCloseReview": true },
  "roamgate": { "port": 8787, "tokenFile": "/path/to/private/access-token" },
  "providerKinds": { "claude": ["claude"], "codex": ["codex"], "opencodego": ["opencode", "pi"] },
  "resourcePools": [
    { "name": "serve-ports", "range": "8000-8004", "split": { "herdrboss": ["8000", "8001"] }, "env": "HERDR_SERVE_PORT", "ttlMinutes": 240, "check": "tcp", "graceMinutes": 10 }
  ]
}
```

## Remote access

The server listens on all local interfaces. Requests from `127.0.0.1` need no login.

1. Open `http://<LAN-or-Tailscale-IP>:4477` on the other device.
2. Enter the token from `~/.config/herdr-boss/access-token`. Herdr Boss creates this file on first start. The directory has mode `0700`. The token and session files have mode `0600`.

The session lasts 30 days and renews while the device uses the dashboard. It survives a service restart. Set `access.sessionDays` to change the length. The server stores only hashes of session IDs and the token fingerprint in `~/.config/herdr-boss/sessions.json`, even when you set a custom `access.tokenFile` path. A new token signs every device out. Herdr Boss moves existing default credential files from `~/.herdr-boss/` on first start. An explicit `access.tokenFile` path remains in use. The login form lets a password manager, such as the iPhone keychain, save the token. API clients can send `Authorization: Bearer <token>` instead.

- Tailscale encrypts traffic between tailnet devices. LAN access uses plain HTTP; use it only on a trusted network.
- Set `host` to `127.0.0.1` to turn off remote access.
- To change the token, write a new token to the token file and restart the service.

### Allowed hosts

The server accepts a request only when its `Host` header names `localhost`, `127.0.0.1`, `[::1]`, an address of this machine, or a name that ends in `.ts.net`. Set `allowedHosts` to accept more names. The default is an empty list, so the rule does not change. A wildcard such as `*.example.test` needs two labels after `*.`. `*.localhost` is the only exception. An invalid `allowedHosts`, `log.maxMegabytes`, or `log.keepFiles` value in `config.json` gives the default and one warning on standard error that names the key.

Each entry is a host name such as `factory-two`, or a wildcard such as `*.localhost`. The wildcard matches each name below `localhost`, such as `a.localhost`. It does not match `localhost` itself. An entry has no port, no path, and no address. Herdr Boss writes each entry in lower case. A list holds at most 50 entries.

Edit the list in **Settings → Advanced → Service settings → Service**, or in `config.json`. Separate the names with commas. The change takes effect at once.

A listed host name passes only the host check. A request that does not come from `127.0.0.1` still needs the access token. A request from `127.0.0.1` with a `Host` header of `a.localhost` also needs the token.

### Health route

`GET /api/health` returns the liveness of this Herdr Boss. It follows the factory health contract, version 1.0.0. The route has the same access rule as the other `/api/` routes: a request from `127.0.0.1` needs no login, and any other request needs the token.

| Field | Value |
|---|---|
| `schema` | The number `1`. |
| `contractVersion` | The contract version, `1.0.0`. |
| `version` | The Herdr Boss version from `package.json`. |
| `kitRevision` | The current kit revision, 12 hexadecimal characters. |
| `tickAgeSeconds` | The whole seconds since the last collection pass, or `null` before the first pass. |
| `herdrReachable` | `true` when the last pass read Herdr, `false` when it failed, or `null` before the first pass. |
| `clockOffsetSeconds` | The clock offset in seconds when `chronyc` reports it, or `null`. Positive means the clock is ahead. |

The body has no path, no host name, and no secret. An unavailable reading is `null`.

### Server log

The server writes its log lines to standard output and to `service.log` in the data directory. The log holds the start line, tick failures, and engine events of type `error` and `guard`. The service log file rotates when it reaches `log.maxMegabytes` (default 10). Herdr Boss renames `service.log` to `service.log.1`, and `service.log.1` to `service.log.2`. It keeps `log.keepFiles` old files (1 or 2, default 2) and deletes the older ones at the next rotation. If the rename fails, Herdr Boss still writes the line to `service.log` and prints one warning each minute on standard error. Both settings are in **Settings → Advanced → Service settings → Service**. They take effect at the next write. The launchd agent also writes standard output to `server.log`. Herdr Boss does not rotate that file. `herdr-boss logs` prints `service.log` when it exists.

When Roamgate runs and its token file exists, the header shows a **Roamgate** link. Herdr Boss reads that token only when you open the link.

## Secret store

The secret store holds the login entries that no tool uses now. The store keeps each secret in a sealed file. It protects the inactive logins only: the opencode and pi login files keep the active login in plain form.

- The store is `~/.config/herdr-boss/secrets/`. The directory has mode `0700`.
- One file holds one secret: `NAME.sealed`, mode `0600`. The file holds the value with AES-256-GCM. Each write uses a new random 96-bit nonce. The secret name binds the file, so a renamed file does not open under another name.
- `NAME.sealed.prev` holds the previous value with the same format.
- `index.json` holds metadata only: the name, the provider, the label, the tool, the quota window, the last use, the expiry, the hash of the sealed value, and the hash of the login entry that the last swap wrote. It never holds a value.
- A secret name matches `^[a-z0-9][a-z0-9-]{0,63}$`.

Use `herdr-boss secret set NAME [--provider P --label L --expires ISO]` to store a value from stdin. A terminal prompt does not echo the value. Backspace and Delete remove the last character. Enter or Ctrl-D ends the value. Ctrl-C cancels the command and exits 130. A pipe may end with one LF or CRLF; the command strips that final newline. It refuses an empty value, a value over 4096 bytes, and any other whitespace. It reads at most 4097 bytes from stdin. Use `herdr-boss secret list` to print names and metadata. Use `herdr-boss secret remove NAME` to type the name again and remove the value and its previous copy. Use `herdr-boss secret check [NAME]` to print `ok` or `failed` for each value.

The check decrypts each value in memory. It accepts 1 to 4096 bytes of valid UTF-8 with no control character and no whitespace. The per-provider validator table is empty until a provider format is verified. The list, check, and audit record never print or store a value.

Each secret command appends one JSON line to `audit.jsonl` in the secrets directory, except a command refused in an agent pane or a `secret set` cancelled with Ctrl-C. The file has mode `0600`. The line holds the name, action, and time. It holds no value, key, or value length.

Run `secret set`, `secret remove`, and `secret check` in an Owner terminal. They refuse in an agent pane and exit 3. This guard prevents accidents. It is not a security boundary because an agent can unset the environment variables. `secret list` works in a pane. Exit 0 means done. Exit 1 means invalid input, a failed check, or another command failure. Exit 130 means you cancelled `secret set` with Ctrl-C.

The master key is 32 random bytes.

- On macOS the keychain holds the key. The `security` command receives the key through stdin, never as a process argument.
- On Linux the key is a file with mode `0600`, outside the volumes that `factory backup` copies. Herdr Boss refuses group or other access and says to run `chmod 600`. A copy of the `home` volume holds no master key.
- A backup that holds both the store and the key opens the store. On Linux, keep the store and the key in different backups.

An agent runs as the same user as Herdr Boss. The file mode does not stop that agent. The rule "agents must not read the private directory" is the barrier. The store protects against a stolen file copy and against a value in a log line. It does not protect against a hostile process of the same user.

## Usage records

When a `report.md` line starts with `Status: done` and the next character is whitespace, punctuation, or the end of the line, collection checks each configured artifact rule. It accepts lines such as `Status: done.` and `Status: done — checks complete`. It ignores `Status: doneish`, `Status: done-partial`, `Status: partial`, and `Status: failed`. Collection warns when the newest source file is newer than the oldest artifact file, or when matching sources have no matching artifacts. It prints each warning and includes it in the `artifactWarnings` summary field. The warning does not change the independent gate result. The orchestrator decides whether the gate passed.

`worker collect` records one usage event per worker run before merge. An unknown tool-call count stays `null`, and the ledger accepts `null` as unknown. If an older kit reports a ledger entry with `null` as invalid, install a HerdrBoss kit version that accepts `null`, then run `herdr-boss ledger check` again. This check reads the ledger. Do not replace `null` with `0` or edit the ledger entry. After a successful collection, Herdr Boss prints a reminder to merge the branch and then run `herdr-boss worktree prune --apply`. Collection does not remove a worktree. `herdr-boss usage record FILE` adds measured events. The Analytics page shows recorded usage and its coverage. Quota percentages are global per provider. They are not project token counts.
