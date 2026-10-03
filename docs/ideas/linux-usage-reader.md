# Linux usage reader (ONB1h)

Status: research. No code. Decision D14 in `docs/plans/docs-and-onboarding.md` asks for a way to read usage limits on Linux, where CodexBar does not exist.

## Interface to match

`collectQuotas()` in `src/collect.js` runs `codexbar usage --format json --provider <p>` for each provider in `QUOTA_PROVIDERS`. It reads one row for each provider. The reader needs these row fields:

- `provider`, `error`, and `usage.loginMethod` (the plan).
- `usage.primary`, `usage.secondary`, `usage.tertiary`: each has `usedPercent`, `resetsAt`, and `windowMinutes`.
- `rateWindowLabels`, `usage.updatedAt`, and the optional `pace`, `credits`, and `codexResetCredits` fields.

The pace fields are optional. Herdr Boss can compute pace from the windows. The Linux reader must give `usedPercent` and `resetsAt` for each window.

## Codex CLI

Option C1: the Codex app server. `codex app-server generate-json-schema` prints the protocol. It defines the request `account/rateLimits/read`. The response `GetAccountRateLimitsResponse` holds `rateLimits` (a `RateLimitSnapshot`) and `rateLimitsByLimitId`. A snapshot has `planType`, `primary`, `secondary`, `credits`, and `rateLimitReachedType`. A window has `usedPercent`, `windowDurationMins`, and `resetsAt` (Unix seconds). The server also sends the notification `account/rateLimitsUpdated`. The server runs on Linux and uses the existing Codex login. The command `codex app-server` is marked experimental, so the protocol can change.

Option C2: read the rollout files in `~/.codex/sessions`. These files can hold rate limit snapshots from past turns. The data is only as new as the last turn, and the format has no vendor contract. Do not use this option.

## Claude Code

Option A1: the status line. Claude Code runs the `statusLine` command from `settings.json` and sends JSON on stdin. The documented fields are `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, and `resets_at` (Unix seconds) for each window. Source: https://code.claude.com/docs/en/statusline.

Limits of A1:
- `rate_limits` exists only for Claude Pro and Max plans, and only after the first API response in a session.
- Each window can be absent.
- A running Claude Code session must exist. A helper script must write each JSON to a file under the data folder. Herdr Boss reads the file.
- The Owner must add the `statusLine` setting. The kit rule says that only the Owner adds Claude settings lines.

Option A2: the `/usage` command in an interactive session. It has no JSON output. The `claude --help` output lists no usage subcommand. Do not use this option.

Option A3: the OAuth usage endpoint that CodexBar-type tools call. No vendor document describes it. It needs the OAuth token from `~/.claude/.credentials.json`. Herdr Boss must not read that file. Do not use this option.

## Compare

| Option | Source | Vendor contract | Login needed | Fresh without a session |
|---|---|---|---|---|
| C1 | `codex app-server` | Generated schema, experimental | Existing Codex login | Yes |
| A1 | Status line JSON | Documented | Pro or Max | No |
| C2, A2, A3 | Files, TUI, endpoint | None | - | - |

## Recommendation

1. Add a Linux reader module that returns rows in the CodexBar row shape. Then `collectQuotas()` needs only a different runner on Linux.
2. For Codex, use C1. Start `codex app-server` as a child process, send `account/rateLimits/read`, map `primary` and `secondary` to the window fields, and stop the child. Pin the check to the installed version: run `codex app-server generate-json-schema` in `doctor` and compare the method name.
3. For Claude, use A1. Ship a status line helper that writes the `rate_limits` object and the time to `<data folder>/claude-rate-limits.json`. Show the reading as stale after the Claude window time passes `resets_at`, as `STALE_QUOTA_MS` does for other rows.
4. Show a clear message when a source is absent: "No Claude usage reading. Add the status line setting." The Owner adds the setting. The setup wizard prints the exact line.
5. Keep CodexBar as the first choice on the Mac. Use the Linux reader when `codexbar` is missing.

## Open points

- Test C1 against a signed-in Codex on a Linux host. This research ran only on a Mac and read the schema, not a live response.
- Check that the status line fires often enough with several workers. Each Claude session writes its own file, so the reader takes the newest `observedAt`.
- The `rate_limits` field names depend on the Claude Code version. The `doctor` check must report the version.
