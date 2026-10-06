# FS1 design note: secret store and login rotation

Status: design only. This note holds no product code. Step 2 starts after the Owner accepts the decisions in the last section.

Scope: the secret store, the commands `herdr-boss secret` and `herdr-boss account`, quota-driven rotation of the OpenCode Go login, the head office view, and the dashboard Settings.

## Facts and gaps

The Owner has two OpenCode Go subscriptions and swaps the login in opencode and pi by hand (`docs/specs/factories.md`, Further Notes). One subscription is in use. The other resets about 5 days 11 hours after 2026-10-06 11:30 local time.

Two facts are not verified. Step 2 must verify them before it writes code.

- The key names inside the opencode login file are not verified. The file is read only through its public documentation.
- The pi login location is not verified. The public pi documentation was not read, because the lookup was blocked in this session.

## 1. Where the tools keep the provider login

### opencode

- The login file is `~/.local/share/opencode/auth.json`. Source: public opencode documentation, page "Providers" (opencode.ai/docs/providers). The `/connect` command in the opencode TUI writes it.
- The file is a JSON object. Each top-level key is a provider name. Each value holds the login data of that provider. Source: the same page.
- The documentation names no environment variable that moves the file.
- Opencode Go models use the model prefix `opencode-go/`. Source: `src/control.js:43` and `src/control.js:576`.
- Not verified: the provider key for OpenCode Go, the field names of an entry, and the file mode.

### pi

- The pi data directory is `~/.pi/agent/`. Source: `docs/ideas/gui-settings-audit.md:84` names `~/.pi/agent/extensions/herdr-guard.ts`.
- Not verified: the login file name, its key names, its format, and its mode.

### Discovery step for the Owner

Step 2, slice 0 adds a read-only command: `herdr-boss account probe`. The Owner runs it at a terminal. It prints only file paths, file modes, and key names. It never prints a value. The slice records the result in `docs/reference/harness-setup.md`.

Agents do not run the probe against the real login files.

## 2. Threat model and layout

### Threats

1. A secret reaches a pane, a report, a log, the repository, a backup, or the head office.
2. An agent reads the private directory `~/.config/herdr-boss/`.
3. A copy of the secret store file leaves the machine, for example in a backup or a cloud folder.
4. A swap leaves a half-written login file.

### Limit of the protection

An agent runs as the same OS user as Herdr Boss. The OS file mode does not stop that agent. The rule "agents must not read the private directory" (`AGENTS.md`, Safety rules) and the agent hooks are the barrier against an agent. The store protects against a stolen file copy and against a value in a log. It does not protect against a hostile process of the same user. The user guide must say this.

The opencode and pi login files hold the active login in plain form. The tools need that. The secret store therefore adds no protection to the active login. It protects the inactive logins.

### Layout

- Directory: `~/.config/herdr-boss/secrets/`, mode 0700.
- One file per secret: `NAME.sealed`, mode 0600. The file holds one value, encrypted with AES-256-GCM. The file name is the secret name.
- Metadata file: `index.json` in the same directory, mode 0600. It holds names and metadata only: provider, account label, harness, quota window, last used, expiry, and the hash of the sealed value.
- Master key: a random 32-byte key. The key location depends on the platform, as described below.
- The server reads the metadata and gives it to the dashboard. The server never gives a value to the dashboard, an API route, a log line, or a Fleet summary.
- A secret name matches `^[a-z0-9][a-z0-9-]{0,63}$`. This is the same pattern that `src/fleet-quotas.js:5` uses for slugs.

### Master key: keychain or file

| Option | macOS | Linux factory |
| --- | --- | --- |
| A. OS keychain holds each value | Strong against a file copy. Needs an extra code path. No Linux equivalent in a container. | Not possible |
| B. File store, master key in the keychain | Strong against a file copy. One store format. | Not possible |
| C. File store, master key in a 0600 file | Weak against a copy of the whole directory. One code path. | Works |

Recommendation: option B on macOS and option C on Linux, with one store format for both. Only the place of the master key differs. The factory image has no keychain, so the file variant is required for factories (`docs/specs/factories.md`, section "Linux portability").

Risk to solve in slice 1: the macOS `security` command can take a secret as an argument. An argument is visible in the process list. The slice must pass the master key through `security -i` on stdin, or through a native library, and must test that no secret appears in an argument.

## 3. Commands

All commands run at a terminal. A command never takes a secret as an argument.

### Secret commands

- `herdr-boss secret set NAME [--provider P --label L --expires ISO]`. The value comes from stdin only. With a terminal on stdin, the command prompts without echo. The command refuses a value in an argument.
- `herdr-boss secret list`. It prints names and metadata. It never prints a value.
- `herdr-boss secret remove NAME`. It asks for the name typed again. It overwrites the sealed file before it deletes the file.
- `herdr-boss secret check [NAME]`. It decrypts each value in memory and checks the format. It prints `ok` or `failed` for each name. It never prints a value.
- Every command writes one audit line with the name, the action, and the time. The line holds no value.

### Account commands

- `herdr-boss account list`. It prints the accounts, the active one for each tool, and the quota reading of each account.
- `herdr-boss account use PROVIDER LABEL`. It swaps the login in opencode and in pi in one operation. For provider `opencode-go`, the operation does these steps:
  1. Take the account lock. Refuse when another swap runs.
  2. Check that no worker of the harness runs. Refuse when one runs, unless the Owner passes `--allow-running`. A worker that runs keeps the old login until it ends.
  3. Write the current login back into the store when its value differs from the stored value. The tools can refresh a login in place, so the stored copy can become old.
  4. Copy the old login file of each tool to `~/.config/herdr-boss/backups/` at mode 0600. Keep the last five copies for each tool.
  5. Write the new login to a temporary file in the same directory as the target. Set mode 0600. Call `fsync`. Rename the temporary file over the target.
  6. Verify opencode with `opencode run` and a one-word prompt on a model of the account. Verify pi with one print-mode call. Step 2 confirms the exact pi flags.
  7. Roll back both tools from the backups when one verification fails. Verify again after the rollback.
  8. Post one Mailbox item on a failure. The item names the account label and the failed tool. It holds no value.
- The verification calls use quota. Each swap costs two small calls.
- The command prints the label, the result of each step, and the exit code. Exit code 0 means both tools use the new login. Exit code 1 means the swap failed and the old login is restored. Exit code 3 means the swap waits for a running worker.

## 4. Rotation rules

Rotation is a rule in the engine tick. It uses the existing pacing goals.

### Existing pieces

- `pacingGoal(policy, provider, key)` returns the goal percent of a quota window (`src/control.js:695`). `pacingGoalEnd` returns the goal end time (`src/control.js:701`).
- The quota state has one reading for each provider. The OpenCode Go provider key is `opencodego` (`src/control.js:576`). A second subscription has no place in this state today.
- `validateAccounts` accepts one account for each harness and refuses a repeated harness (`src/fleet-quotas.js:7` to `src/fleet-quotas.js:19`). The Fleet summary quota row carries `harness`, `accountKey`, `lane`, `usedPercent`, `resetAt`, and `status` (`docs/contracts/examples/fleet-summary.valid.complete.json`).
- I did not trace the code that reads the quota of `opencodego`. Slice 5 traces it first.

### Per-account reading

- Add an account label to each quota reading. The reading key becomes provider plus label.
- Both subscriptions show on the Analytics view, one lane for each label.
- The inactive account needs a reading without a swap. The reading code takes the credential of the account from the store at read time and does not touch the login file of a tool. If the provider offers no such reading, the inactive account shows the last known reading and its reset time. The Owner can enter a known reset time by hand for the second subscription.
- `validateAccounts` accepts several accounts for one harness when the labels differ. The account key HMAC stays the same (`src/fleet-quotas.js:24`).

### Switch rule

Rotation switches from the active account A to the other account B when all of these conditions hold:

1. The rotation setting is on.
2. The usage of A in its goal window is at or above its pacing goal, or A is exhausted.
3. B has an open window: its usage is below its goal, or its reset time has passed.
4. No worker of the harness runs, or the Owner allowed a switch with running workers.
5. The last switch is older than a minimum interval of 6 hours. This stops swapping back and forth.

When condition 4 fails, rotation waits. The tick checks again. Rotation posts one Mailbox item that says running workers keep the old login until they end. Rotation never stops a worker.

Rotation never switches when only one account has a reading. It never switches to an account whose last verification failed.

## 5. Factories

- A secret belongs to one factory. It never leaves that factory (`docs/specs/factories.md`, user stories 72 and 78: "secrets and logins stay at the source", "host secrets, SSH keys, and fleet credentials stored where agents must not read them").
- A project transfer never moves a secret. The target asks again in the wizard (`docs/specs/factories.md`, "Project transfer").
- The head office may track these facts: secret names, account labels, provider, expiry date, last used time, the verification result, and quota readings with the `accountKey` (`docs/specs/factories.md`, section "Fleet summary and credentials").
- The head office never receives a value, a login file path, or an account identity. The Fleet summary allow-list test must fail when a secret field appears (`docs/specs/factories.md`, user story 48). The contract fixtures `fleet-summary.invalid.account-identity.json` and `fleet-guidance.invalid.account-identity.json` already name this rule.
- Step 2 adds to the Fleet summary only the fields that the allow-list names: a list of account label, provider, expiry, and verification result. The schema only adds fields (`docs/specs/factories.md`).
- A transfer of a value between factories needs a command that the Owner runs at a terminal: `herdr-boss secret export NAME --to FACTORY`. The command prompts for a typed confirmation. It sends the sealed value over the host tool channel and never through the head office, the Mailbox, or a pane. This command is optional. Step 2 builds it only when the Owner accepts decision 4.
- The account scope in the factories spec already limits which factories may use an account (`docs/adr/0011-factory-shares-and-guidance.md:11`). A factory reads a secret only when its factory id is in the scope of the account.

## 6. Dashboard

- Settings gets a section "Accounts and secrets". It follows the rule that each managed resource is visible and settable (`AGENTS.md`, Documentation).
- The section lists each secret name with provider, account label, quota window, last used, and expiry. It never shows a value.
- The section shows the active account of opencode and of pi.
- A toggle "Rotate accounts automatically" sets the rotation. The default is off.
- A button "Switch account" starts `account use`. A confirm step names the label, the harness tools, and the effect on running workers. The button is disabled while a swap runs.
- The dashboard cannot set or read a value. The Owner sets a value only with `secret set` at a terminal. The page help in `HELP` in `public/app.js` says this.
- The Analytics view shows one quota lane for each account label.
- The access token file and the secret values stay outside the dashboard, as a recorded reason (`AGENTS.md`, Documentation).

## Slices for step 2

Each slice fits one worker. Each slice has tests with temporary `HOME` and `HERDR_BOSS_DIR` fixtures. No test reads a real login.

1. Probe and docs. Add `account probe`. Record the verified file paths and key names of opencode and pi in `docs/reference/harness-setup.md`. Needs the Owner to run the command.
2. Store. Add the sealed file format, the index, the master key for macOS and Linux, and unit tests for the format, the mode, and a wrong key.
3. Secret commands. Add `secret set`, `list`, `remove`, `check`, and the audit line. Test that stdin is the only input and that no output holds a value.
4. Account use for opencode. Add the lock, the write-back, the backup, the atomic write, the verification, and the rollback. Use a fake `opencode` binary in the fixture.
5. Account use for pi. Add the same steps for pi, and the joint rollback of both tools. Use a fake `pi` binary.
6. Quota per account. Trace the `opencodego` reader. Add the label to the quota reading. Relax `validateAccounts`. Update the Fleet contract and its examples.
7. Rotation rule. Add the engine rule, the minimum interval, the wait for running workers, and the Mailbox item.
8. Dashboard. Add the Settings section, the toggle, the switch button with the confirm step, the Analytics lanes, and the `HELP` text.
9. Docs and gate. Update `docs/cli.md`, `docs/user-guide.md`, and `docs/reference/quota-plan.md`. Run the docs gate.

## Decisions for the Owner

Each decision has an Accept option and a Deny option.

### Decision 1: where the master key lives

- Accept: the file store with the master key in the macOS keychain. On Linux the master key is a 0600 file.
- Deny: the file store with the master key in a 0600 file on all platforms.
- Recommendation: Accept. A copy of the store directory is then useless without the keychain.

### Decision 2: rotation default

- Accept: the rotation setting is off by default. The Owner turns it on in Settings.
- Deny: the rotation setting is on by default after the first account is stored.
- Recommendation: Accept. A swap changes the login of every tool. The Owner should choose when it starts.

### Decision 3: per-factory secrets

- Accept: each secret stays in the factory that holds it. The head office tracks names, labels, expiry, and quota readings only.
- Deny: the head office also stores sealed values and sends them to factories.
- Recommendation: Accept. This matches the factories spec and keeps a head office takeover harmless.

### Decision 4: transfer of a value between factories

- Accept: build `secret export NAME --to FACTORY` as an Owner terminal command with a typed confirmation.
- Deny: build no transfer command. The Owner runs `secret set` in each factory.
- Recommendation: Deny for the first release. The Owner has two subscriptions and two factories, and `secret set` in each factory is enough.

### Decision 5: swap while a worker runs

- Accept: rotation waits until no worker of the harness runs. A manual switch may pass `--allow-running`.
- Deny: rotation never waits. It switches at once and running workers keep the old login until they end.
- Recommendation: Accept. A wait avoids a mixed state in one project.
