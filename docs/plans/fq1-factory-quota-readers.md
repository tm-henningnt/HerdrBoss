# FQ1 design note: quota readers inside a factory container

Status: design only. This note holds no product code. Step 2 starts after the Owner accepts the decisions in the last section.

Scope: a usage source for Claude, Codex, and OpenCode Go that runs headless inside a Linux factory container with the login of the factory.

## Terms

Each term has one meaning in this note.

- **Reader**: code that returns usage readings for one provider.
- **Reading**: one provider row with windows, in the row shape that `collectQuotas()` returns.
- **Window**: one usage period of a provider. It has a key, a used percent, and a reset time.
- **Source**: the command, endpoint, or file that a reader asks for data.
- **Login**: the sign-in state that a harness keeps in the factory. The login belongs to the harness. Herdr Boss never reads its files.
- **Fake transport**: a test double that replaces the child process or the HTTP client of a reader.
- **Unknown**: a reading that is not available. An unknown reading is not zero.

## Problem

Both live factories (`win1`, `win2`) show `no usage reader in this factory` for Claude, Codex, and OpenCode Go. The Fleet summary quota rows then have the state `unknown`. The Fleet quota total shows 0 of 3 factories reporting.

The cause is in `src/collect.js`. `collectQuotas()` calls `codexbar usage --format json --provider <p>` for each provider (`src/collect.js:252`, `src/collect.js:305`). The image has no `codexbar`, so the call fails with `ENOENT`. `quotaUnavailableReason()` maps `ENOENT` to the reason text (`src/collect.js:235`). The map is a deliberate unknown, not a failure.

Claude and Codex are signed in inside the factories. The login exists. Only the reader is missing.

## What the Fleet needs

The Fleet quota row has the fields `harness`, `accountKey`, `lane`, `usedPercent`, `resetAt`, and `status`. Source: `docs/contracts/factories.md` and `docs/contracts/examples/fleet-summary.valid.complete.json`.

`fleetQuotas()` builds each row from one reading window (`src/fleet-quotas.js:34`). The mapping is:

| Fleet field | Reading field | Rule |
|---|---|---|
| `harness` | account record | `opencode` maps to the provider `opencodego` (`src/fleet-quotas.js:37`). |
| `accountKey` | account record | An HMAC digest from `provisionAccount()`. A reader does not produce it. |
| `lane` | `window.key` | A slug. A key that is not a slug becomes `unknown`. |
| `usedPercent` | `window.usedPercent` | A number from 0 to 100. Any other value becomes `null` (`src/fleet-quotas.js:32`). |
| `resetAt` | `window.resetsAt` | An ISO 8601 string. A number is not accepted (`src/fleet-quotas.js:33`). |
| `status` | reading | `unknown` when the row has `error`, `stale`, or no percent. `exhausted` at 100. `ahead` when `willLast` is `false`. Otherwise `ok`. |

A reader must therefore return `windows[]` with `key`, `usedPercent` (0 to 100), and `resetsAt` as an ISO string. The reader must convert Unix seconds to ISO. The optional fields (`windowMinutes`, pace) are not part of the Fleet row. The local dashboard uses them, so a reader should set `windowMinutes`.

The provider keys are `codex`, `claude`, and `opencodego` (`src/collect.js:89`). The window keys that CodexBar produces are `primary`, `secondary`, and `tertiary` (`src/collect.js:346`). A reader uses the same keys, so the pacing code and the dashboard need no change.

## Rules for every reader

- A reader never reads a login file of a harness: not `~/.claude`, not `~/.codex`, not `~/.local/share/opencode`, not `~/.pi`. The harness program reads its own login.
- A reader never prints, stores, or logs a credential. It never puts a credential in `argv` or in the environment of a child process.
- A reader that needs a credential reads it from stdin or from an inherited file descriptor. Section "Unknown, reason" lists the one case that needs this.
- A reader runs as the factory user with `HOME=/home/factory`, the same as the workers (`src/factory-role.js:6`).
- A missing program or a missing login gives an unknown reading with a reason. It does not give a failure (`src/collect.js:233`).
- A reader returns a row with `error` as a string for each other failure. The existing code then keeps the last good row as stale (`keepStaleRows`, `src/collect.js:403`).
- A reader never retries inside one call. The engine backs off each provider (`QUOTA_TIMEOUT_BACKOFF_BY_PROVIDER_MS`, `src/collect.js:91`).

## Codex

### Source

The source is the Codex app server, started as a child process: `codex app-server --listen stdio://`. The default transport is `stdio://`. Source: `codex app-server --help` (codex-cli 0.160.1).

The request is `account/rateLimits/read`. The response is `GetAccountRateLimitsResponse`. Source: `docs/ideas/linux-usage-reader.md`, section "Codex CLI", which read the output of `codex app-server generate-json-schema`.

The same document lists these response fields:

- `rateLimits`: a `RateLimitSnapshot` with `planType`, `primary`, `secondary`, `credits`, and `rateLimitReachedType`.
- `rateLimitsByLimitId`: more snapshots, one for each named limit.
- window: `usedPercent`, `windowDurationMins`, and `resetsAt` (Unix seconds).

The server also sends the notification `account/rateLimitsUpdated`. The reader does not need it.

### Input

- The app server uses the Codex login that already exists in the factory. The reader passes no credential.
- The reader needs the program `codex` on `PATH` and `HOME=/home/factory`.
- The login state check is `codex login status`. Source: `codex login --help`. The reader may run it first to separate "not logged in" from "endpoint failed".

### Output mapping

| Fleet or reading field | Codex field |
|---|---|
| `plan` | `rateLimits.planType` |
| window `primary` | `rateLimits.primary` |
| window `secondary` | `rateLimits.secondary` |
| `usedPercent` | `window.usedPercent` |
| `resetsAt` | `new Date(window.resetsAt * 1000).toISOString()` |
| `windowMinutes` | `window.windowDurationMins` |
| `credits` | `rateLimits.credits` (optional) |
| extra windows | each entry of `rateLimitsByLimitId` that is not the default limit, as `extra: true` |

### Procedure

1. Start `codex app-server --listen stdio://` with `stdio: ['pipe', 'pipe', 'pipe']`.
2. Send the `initialize` request, then the `initialized` notification. The protocol is JSON-RPC over lines on stdio. Unverified: the exact `initialize` parameters. See "Unknown, reason".
3. Send `account/rateLimits/read`.
4. Read lines from stdout until the response with the same `id`, or until the timeout.
5. Close stdin. Send `SIGTERM` to the child. Send `SIGKILL` after a grace time. Reuse the kill code of `runQuotaCommand` (`src/collect.js:104`).

### Failure modes

| Case | Signal | Result |
|---|---|---|
| `codex` is missing | `ENOENT` | unknown, reason `no usage reader in this factory` |
| Not logged in | a JSON-RPC error on the request, or `codex login status` exits non-zero | unknown, reason `no login for this harness in this factory` |
| Login is an API key, not a ChatGPT account | the method can return an error or empty limits | unknown. Unverified: the response for an API key login. |
| Rate limited or the backend fails | a JSON-RPC error | row `error`, stale row kept |
| Protocol change | the method name is refused (`method not found`) | row `error` with the text `codex app-server protocol changed`. The doctor check shows the Codex version. |
| Child does not answer | timeout | row `error`, backoff |

### Not possible

- The app server is marked experimental. The vendor gives no stability promise.
- A reading is as old as the last request to the backend. The reader asks on each poll, so the age is the poll interval.
- Reading rollout files in `~/.codex/sessions` is forbidden by the rules and is not a vendor contract (`docs/ideas/linux-usage-reader.md`, option C2).

## Claude

### Source

Two sources exist. Source 1 is the Claude Code status line. Source 2 is the OAuth usage endpoint.

**Source 1: status line.** Claude Code runs the `statusLine` command of the settings and sends JSON on stdin. The documented fields are `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, and `resets_at` (Unix seconds) for each window. Source: https://code.claude.com/docs/en/statusline, as cited in `docs/ideas/linux-usage-reader.md`, option A1.

**Source 2: OAuth usage endpoint.** CodexBar and similar tools call an Anthropic endpoint that needs the OAuth token. No vendor document describes the endpoint. It needs the token in the Claude login file. The rules forbid reading that file. Do not use source 2 (`docs/ideas/linux-usage-reader.md`, option A3).

`claude --help` (2.1.287) lists `auth status` (JSON by default) and no usage command. The `/usage` command is interactive and has no JSON output.

### Design: a status line helper that the factory owns

1. The factory image ships a helper script, `herdr-boss claude-statusline`. The script reads the status line JSON on stdin.
2. The script keeps only `rate_limits` and the current time. It writes them to `<data folder>/claude-rate-limits/<session id>.json` with mode 0600. The script prints an empty status line.
3. The helper never writes the other fields of the input.
4. The reader takes the newest file by `observedAt`. It ignores a file older than the window time past `resets_at`.
5. The factory enables the helper in a place that the Owner does not edit by hand. The candidates are the managed settings file of Claude Code, or the `--settings` flag that `herdr-boss` passes when it starts a Claude worker. `claude --help` documents `--settings <file-or-json>`. Which one works for a status line is Unverified. See "Unknown, reason".

The kit rule that only the Owner adds Claude settings lines applies to the Mac. In a factory, the image and `herdr-boss` own the settings, because no Owner sits in the container. Decision 2 asks the Owner to confirm this.

### Input

- A running Claude Code session in the factory with the factory login.
- A Claude plan that reports `rate_limits`. The documentation says Pro and Max plans only, and only after the first API response of a session.
- The reader reads only the files that the helper wrote.

### Output mapping

| Reading field | Claude field |
|---|---|
| `plan` | not in the status line. Use `null`. |
| window `primary` | `rate_limits.five_hour`, `windowMinutes` 300 |
| window `secondary` | `rate_limits.seven_day`, `windowMinutes` 10080 |
| `usedPercent` | `used_percentage` |
| `resetsAt` | `new Date(resets_at * 1000).toISOString()` |
| `updatedAt` | `observedAt` of the file |

Each window can be absent. An absent window gives no window entry. A reading with no window is unknown.

### Failure modes

| Case | Signal | Result |
|---|---|---|
| No file exists | the folder is empty | unknown, reason `no Claude usage reading yet` |
| Helper not enabled | no file after a worker ran | unknown, doctor shows the fix |
| Plan has no `rate_limits` | the key is absent | unknown, reason `no usage limit for this Claude plan` |
| File older than the reset time | `resets_at` is in the past | stale row, then unknown |
| Field names change | a field is missing or has another type | unknown. The doctor check reports the Claude version. |
| Claude not logged in | no session can run | unknown, reason `no login for this harness in this factory` |

### Not possible

- A reading when no Claude session runs. The status line fires only in a session. Mitigation: the factory Boss and the workers run Claude sessions most of the day. A reading goes stale after `STALE_QUOTA_MS` (`src/collect.js:400`).
- A fresh reading without a model call. A synthetic call such as `claude -p` would use quota. Do not add one.

## OpenCode Go

### Source

No usage source is verified for OpenCode Go.

- `opencode --help` (v2.0.20) lists no usage command. `opencode stats` shows token and cost statistics of local sessions. It does not show the subscription limit. Source: `opencode stats --help`.
- `opencode auth export` prints stored credentials, including secrets. Do not run it. A reader must not use it.
- `opencode api <operation>` calls the local OpenCode server. The operations list is not in the help. Unverified: whether any operation returns subscription usage.
- On the Mac, the `opencodego` row comes from CodexBar (`src/collect.js:305`). `codexbar usage --help` lists the provider `opencodego` and the sources `auto|web|cli|oauth|api`. The help does not say which source `opencodego` uses. The note `docs/plans/fs1-secrets-design.md:156` records that the reader is external.
- A web dashboard source needs a browser cookie. A container has no browser profile.

### Input

Unknown. If an account usage endpoint exists, it needs the factory credential. The reader would get the credential by stdin or a file descriptor only. See decision 4 and "Unknown, reason".

### Output mapping

Not defined until a source is verified. The target is the same window shape: `key`, `usedPercent`, `resetsAt` (ISO), and `windowMinutes`.

### Failure modes and not possible

- Until a source exists, the reading stays unknown with the reason `no usage reader in this factory`. This is the current behavior.
- A manual reset time is the fallback that `docs/plans/fs1-secrets-design.md:162` already proposes. It gives a reset time and no percent.
- The Owner can run the read-only commands in "Unknown, reason" to decide whether a source exists.

## Alternative: CodexBar in the image

`docs/spikes/02-mac-orbstack.md:111` records that CodexBar v0.71.0 publishes a Linux CLI (glibc and musl, `aarch64` and `x86_64`). The CLI accepts the arguments of `src/collect.js` and returns the same row shape. Without a login it returns an error row, for example `Claude OAuth credentials not found`.

- Gain: no reader code for Claude and Codex. `collectQuotas()` works unchanged. The Fleet and the dashboard get the Mac rows.
- Cost: 170 MB in the image (`docs/spikes/02-mac-orbstack.md:178`). The CLI reads the login files of the harnesses itself. This is the program of the vendor, not Herdr Boss, so the rule "Herdr Boss never reads a login file" holds. The Owner decides whether that is acceptable (decision 1).
- Unverified: a logged-in reading on Linux. The spike blocked it (`docs/spikes/02-mac-orbstack.md:160`). The check is `codexbar usage --format json --provider claude --source oauth` and `--provider codex`.
- Unverified: whether `opencodego` works on Linux without a browser cookie.
- CodexBar `--source oauth` for Claude uses the undocumented endpoint of source 2. The Claude section rejects that endpoint for Herdr Boss code. Using the CodexBar binary moves the same dependency into the vendor code.

The recommended path builds the Codex and Claude readers in Herdr Boss and keeps CodexBar as the first choice on the Mac. The CodexBar image option is the fallback if the Owner accepts the size and the live check passes.

## Build slices

Each slice fits one Sonnet worker. Do the slices in order. Each slice starts with a failing test on a fake transport. Run only the changed test files with `--test-concurrency=2`.

1. **Reader seam.** Add `src/quota-readers.js` with a function `readQuota(provider, deps)` that returns a CodexBar-shaped row. Add a selection step to `collectQuotas()`: run `codexbar` first. When the error is `ENOENT` and the process is a factory (`isFactoryRole()`), call the Linux reader for that provider. A provider without a Linux reader keeps the current unknown.
   - Failing test: a fake runner that throws `ENOENT` and a fake Linux reader that returns a row. `collectQuotas()` returns the reader row, not `no usage reader in this factory`. The test fails on the current code.
   - Test also: a Mac process (`isFactoryRole()` false) keeps the unknown.
2. **Row builder.** Add a pure function that maps a window `{ key, usedPercent, resetsAtSeconds, windowMinutes }` to a reading window. It converts Unix seconds to ISO and drops a percent outside 0 to 100.
   - Failing test: input `resetsAtSeconds: 1790000000` returns `resetsAt` as an ISO string that `fleetQuotas()` accepts. A value of 120 percent returns `usedPercent: null`.
3. **Codex reader.** Add `readCodexQuota({ spawnJsonRpc, timeoutMs })`. Use a fake transport that replays recorded JSON lines: an initialize response, then an `account/rateLimits/read` response with `primary` and `secondary`.
   - Failing test: the fake sends a valid response. The row has two windows with the keys `primary` and `secondary` and the right ISO reset times.
   - Failing test: the fake sends a JSON-RPC error with the text `not logged in`. The row is unavailable with the login reason.
   - Failing test: the fake never answers. The reader rejects at the timeout and signals the child (reuse of the kill helper).
4. **Claude helper and reader.** Add `herdr-boss claude-statusline` (stdin to file) and `readClaudeQuota({ dir, now })`. The test uses a temporary folder.
   - Failing test: a file with `rate_limits.five_hour` and `seven_day` returns `primary` and `secondary` rows.
   - Failing test: the helper input holds an extra field with the text `SECRET`. The written file does not contain it.
   - Failing test: two files, the newer wins. A file past its reset time gives a stale or unknown reading.
5. **Factory wiring.** Install the helper in the factory image and in the settings path that decision 2 selects. Add the folder to the factory data volume.
   - Failing test: the factory image build test lists the helper path and the settings entry. The entry runs only `herdr-boss claude-statusline`.
6. **Doctor and reasons.** Replace the Linux hint of the `codexbar` check (`src/doctor.js:24`). Add checks: `codex login status`, the Codex version, the presence of the Claude helper file, and the Claude version. Add the new reasons to `quotaUnavailableReason()`.
   - Failing test: a fake doctor runner with `codex` missing gives the Codex hint. A fake with a helper file older than 3 hours gives the Claude hint.
7. **OpenCode Go.** Build only after the Owner reports the result of the read-only commands. If no source exists, add the manual reset time field and keep the unknown reason. If a source exists, add the reader with the credential on stdin.
   - Failing test (source exists): the credential is passed through the stdin of the fake child. The test fails if the credential appears in `argv`, in the child environment, or in any log line.
8. **Fleet check and docs.** Add a Fleet summary test: a Codex reading with two windows gives two quota rows with state `ok`. Update `docs/cli.md`, `docs/user-guide.md`, `docs/guide/factory.md` (the paragraph at line 123), `docs/harness-setup.md`, and the dashboard help (`HELP` in `public/app.js`). Run `node scripts/docs-gate.js --base main`.

## Live check plan for win1 and win2

All checks are read-only and print readings only. A reading is a window key, a used percent, and a reset time. Nothing in the plan prints a credential.

1. For each factory `win1` and `win2`, run `herdr-boss factory status <name>`. Expect a healthy container.
2. Run `docker exec -u factory hf-<name> codex --version` and `docker exec -u factory hf-<name> claude --version`. Record both versions.
3. Run `docker exec -u factory hf-<name> codex login status`. Expect a logged-in state. Do not run a login command.
4. Run the Codex reader once through a one-off Node call that prints window keys, percent values, and reset times. Compare with the Codex usage page that the Owner sees. The values must agree within the poll interval.
5. Start a short Claude session in the factory. Run `ls -l` on the helper folder. Expect one file with mode 0600. Print only `rate_limits` through the reader.
6. Run the Fleet summary route of each factory. Expect quota rows with the state `ok` or `ahead` for Codex and Claude.
7. Open the Fleet page. Expect the quota total to count 3 of 3 factories, or 2 of 3 while OpenCode Go stays unknown.
8. Stop the Claude session and wait past the stale limit. Expect the Claude row to turn stale, then unknown, and no Boss warning.

## Unknown, reason

| Item | Reason | Read-only command for the Owner |
|---|---|---|
| Exact `initialize` parameters of `codex app-server` | This note ran only `--help`. The rules forbid a protocol call. | `codex app-server generate-json-schema --out <temporary folder>`. Read `ClientRequest` and `InitializeParams`. The command writes a schema and needs no login. |
| Response for an API key login | Needs a live Codex. | In `win1`: `codex login status`. It prints the login kind without a value. |
| Whether a managed settings file or `--settings` can set `statusLine` in the factory | The documentation was not fetched. The rules forbid a network call. | Read the settings page of the Claude Code documentation. Check the keys `statusLine` and the managed settings path. |
| Whether the factory Claude login (`claude setup-token`, `docs/spikes/02-mac-orbstack.md:153`) returns `rate_limits` | Needs a live session. Setup tokens may differ from a browser login. | In `win1`: `claude auth status`. It prints the login method. Then run the live check step 5. |
| Whether any OpenCode Go usage source exists | The help lists none. The endpoint, if any, is undocumented here. | `opencode api --help` lists the operations. Run it in `win1`. Then read the OpenCode Go pages of the vendor for a usage view. |
| Which CodexBar source `opencodego` uses | The help does not say. | `codexbar usage --provider opencodego --pretty` on the Mac. Read only the source label in the output. |
| CodexBar numbers on Linux | The spike blocked the check. | The commands in section "Alternative: CodexBar in the image". |
| Key names in the OpenCode login | The rules forbid reading the file. | The Owner runs `herdr-boss account probe` when FS1 slice 1 ships. It prints key names only. |
| Whether a Claude status line fires often enough with several workers | Needs a live fleet of sessions. | Live check step 5 with three workers. |

## Decisions for the Owner

1. CodexBar in the image (170 MB), or own readers for Codex and Claude.
   - Recommend: own readers. They use documented or generated interfaces and add no vendor binary that reads the logins.
2. Let the factory image own a Claude status line setting for the helper.
   - Recommend: accept. The container has no Owner session, and the setting runs only the helper.
3. Accept a Claude reading only while a Claude session runs.
   - Recommend: accept. The alternative is a model call that uses quota.
4. OpenCode Go: run the read-only commands in "Unknown, reason" and report the result. If no source exists, accept the manual reset time and the unknown reading.
   - Recommend: accept.
