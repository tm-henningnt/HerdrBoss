# FQ4: the CodexBar CLI in a factory

Scope: install the pinned CodexBar CLI in a factory, give it a config, and use it as the first usage reader.
This plan covers the OpenCode Go credential supply only. The install and the reader selection are in the code.

## What the factory runs

The image holds the pinned CodexBar binary. A service update also installs or repairs the binary in
`~/.local/bin/codexbar` of the factory user. The step checks the version, downloads the pinned tarball, and
verifies its SHA-256 before it unpacks it. It writes `~/.config/codexbar/config.json` with mode 0600 and the
providers `codex`, `claude`, and `opencodego`, each with the source `auto`.

`collectQuotas` runs `codexbar usage --format json --provider <p>` first, as it does on the Mac. It falls
back to the own readers only when `codexbar` is missing. The own Codex reader and the Claude status line stay
as fallbacks. A reading names its source in the dashboard, for example `app-server`, `helper`, `oauth`, `cli`, or `api`.

## OpenCode Go account windows

CodexBar reads the local OpenCode cost history from the SQLite database of the factory user. That reading
needs no credential. The account usage windows (five hours, week, month) need an `OPENCODE_API_KEY`.

The Owner has four OpenCode Go keys: two subscriptions for `win1` and two subscriptions for `win2`. Each
factory gets one key for each of its subscriptions. The names are `opencode-go-a` and `opencode-go-b` inside
each factory.

## Supply route

Route: the FS1 secret store. The store is the only route. Slice A of FS1 holds the store. The set and get
commands come in a later slice. This plan does not wait for them.

Rules for the store and the account model:

1. The store holds one key for each subscription of each factory: `opencode-go-a` and `opencode-go-b`.
2. The account model keeps one account per key. The account names the factory and the subscription.
3. The key enters `apiKey` of the `opencodego` provider in the CodexBar config of that factory. A later
   install or repair step keeps that field.
4. No command line, log, report, or test output holds the key value. Read the key from a file descriptor or
   from stdin. Never pass it as an argument.

Until a key exists, OpenCode Go shows the local cost history only. The reason text is
`account windows need an API key`.

## Open items

- The FS1 slice that writes a key into the CodexBar config of a factory is not written yet.
- A live account-window reading on Linux is not verified. The orchestrator runs that check.
- The Factory Settings row that shows the source and the age of each reading is not checked in a browser.
