# FS1 design note: secret store and login rotation

Status: design only. This note holds no product code. Step 2 starts after the Owner accepts the decisions in the last section.

Scope: the secret store, the commands `herdr-boss secret` and `herdr-boss account`, quota-driven rotation of the OpenCode Go login, the head office view, and the dashboard Settings.

## Terms

Each term has one meaning in this note.

- **Login**: the data that lets a tool call a provider. It is the entry of one provider in a tool login file.
- **Secret**: a login that the store holds, sealed. The store holds a login only.
- **Value**: the sealed or plain data of a secret or of a login entry, for example an API key. A value is never printed.
- **Label**: the name of an account in Herdr Boss. A label is a slug. It never holds an email address or the name of an account.
- **Tool**: `opencode` or `pi`.
- **Swap**: the operation of `account use`. It replaces the login of one provider in the login file of each tool.
- **Rotation**: the engine rule that starts a swap by itself.
- **Refuse**: the command stops, changes nothing, and exits with a non-zero code.

## Facts and gaps

The Owner has two OpenCode Go subscriptions and swaps the login in opencode and pi by hand. Source: the Owner spec for FS1, which is not in the repository. One subscription is in use. The other resets about 5 days 11 hours after 2026-10-06 11:30 local time.

Five facts are not verified. Step 2, slice 1 verifies them before it writes code.

- The key names inside the opencode login file. The file is known only from its public documentation.
- The pi login location.
- Whether a running tool reads its login file again during a run. Decision 5 depends on this fact. Until slice 1 verifies it, treat the claim "a running worker keeps the old login" as unverified.
- Whether an environment variable, `XDG_DATA_HOME`, or an `apiKey` field in a tool configuration file overrides the login file.
- Whether an entry has a stable non-secret identity field: a field that keeps its value when the tool refreshes the login, for example an account id. The write-back in section 3 depends on this fact.

The code that reads the `opencodego` quota is not traced. Slice 6 traces it first.

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

Step 2, slice 1 adds a read-only command: `herdr-boss account probe`. The Owner runs it at a terminal. It prints only file paths, file modes, and key names. It never prints a value. It refuses in an agent pane. Slice 1 decides the method that detects an agent pane. All refusing commands use that method. The slice records the result in `docs/harness-setup.md`.

The probe also prints the names, never the values, of these items:

- environment variables that match `OPENCODE`, `_API_KEY`, or `XDG_DATA_HOME`
- `apiKey` fields in the opencode and pi configuration files
- the candidate identity fields of each login entry, as key names

Agents do not run the probe against the real login files.

## 2. Threat model and layout

### Threats

1. A secret reaches a pane, a report, a log, the repository, a backup, or the head office.
2. An agent reads the private directory `~/.config/herdr-boss/`.
3. A copy of the secret store file leaves the machine, for example in a backup or a cloud folder.
4. A swap leaves a half-written login file.
5. A value reaches the argument list or the environment of a child process, or an error message.

### Rules for a value

- A value never goes into the argument list or the environment of a child process. This covers `codexbar`, `opencode`, `pi`, `security`, and `ssh`. A value goes into a child only through stdin or a file descriptor.
- A reader that has no stdin or file descriptor input does not read the inactive account. The inactive account then shows the last known reading.
- Code on the login path redacts error text. A provider error body can hold part of a key. Node diagnostic reports print the environment and the argument list, so no value stays in the environment.
- A test checks that no value appears in an argument, in the environment of a child, in an error, or in a log line.

### Limit of the protection

An agent runs as the same OS user as Herdr Boss. The OS file mode does not stop that agent. The rule "agents must not read the private directory" (`AGENTS.md`, Safety rules) and the agent hooks are the barrier against an agent. The store protects against a stolen file copy and against a value in a log. It does not protect against a hostile process of the same user. The user guide must say this.

The opencode and pi login files hold the active login in plain form. The tools need that. The secret store therefore adds no protection to the active login. It protects the inactive logins.

On Linux the master key is a file. A backup of the volume that holds both the store and the key holds both. On Linux the store therefore gives no protection against threat 3 when one backup holds both (see "Master key" below).

### Layout

- Directory: `~/.config/herdr-boss/secrets/`, mode 0700.
- One file per secret: `NAME.sealed`, mode 0600. The file holds one value, encrypted with AES-256-GCM. The secret name is bound as additional authenticated data, so a renamed file does not open under another name. Each write uses a new random 96-bit nonce.
- Previous value: `NAME.sealed.prev`, mode 0600, same format and same name binding. A write-back (section 3) moves the old `NAME.sealed` to this file before it writes the new value. The next verified swap deletes it.
- Metadata file: `index.json` in the same directory, mode 0600. It holds names and metadata only: provider, label, tool, quota window, last used, expiry, and the hash of the sealed value, and the hash of the entry that the last swap wrote.
- Master key: a random 32-byte key. The key location depends on the platform, as described below.
- The server reads the metadata and gives it to the dashboard. The server never gives a value to the dashboard, an API route, a log line, or a Fleet summary.
- A secret name matches `^[a-z0-9][a-z0-9-]{0,63}$`. This is the same pattern that `src/fleet-quotas.js:5` uses for slugs.
- A secret holds the login entry of one provider only. For OpenCode Go it is the entry of the OpenCode Go key in `auth.json`. It is never the whole login file.

### Master key

| Option | macOS | Linux factory |
| --- | --- | --- |
| Keychain per value: the OS keychain holds each value | Strong against a file copy. Needs an extra code path. | Not possible: a container has no keychain |
| Keychain key: file store, master key in the keychain | Strong against a file copy. One store format. | Not possible |
| File key: file store, master key in a 0600 file | Weak against a copy of the whole directory. One code path. | Works |

Recommendation: keychain key on macOS and file key on Linux, with one store format for both. Only the place of the master key differs. The factory image has no keychain, so the file key is required for factories (`docs/specs/factories.md`, section "Linux portability").

Rule: the master key is never in the same backup as the store. On macOS the keychain holds the key outside the store directory. On Linux the key path is outside the `home` volume that `factory backup` copies (`docs/specs/factories.md`, user story 59). Alternatively the host tool keeps the factory master key in the host keychain and gives it to the container at start through stdin or a file, never through the environment (rule in section 2). Slice 2 picks one and tests that a copy of the `home` volume holds no master key.

If Decision 1 is denied, the macOS key is a 0600 file too. A Time Machine copy of the home folder then holds the store and the key. Slice 2 puts the key file outside the backed-up folders where the platform allows it, and the user guide names this limit.

Risk to solve in slice 2: the macOS `security` command can take a secret as an argument. An argument is visible in the process list. The slice passes the master key through `security -i` on stdin, or through a native library, and tests that no secret appears in an argument.

## 3. Commands

A command never takes a secret as an argument.

`secret set`, `secret remove`, `secret export`, `secret check`, `account use`, and `account probe` refuse in an agent pane. `secret check` and `account probe` read the private directory or the login files. `secret list` and `account list` print metadata only and do not refuse. The Owner runs the refused commands at a terminal. Slice 1 decides the method that detects an agent pane.

### Secret commands

- `herdr-boss secret set NAME [--provider P --label L --expires ISO]`. The value comes from stdin only. With a terminal on stdin, the command prompts without echo. The command refuses a value in an argument.
- `herdr-boss secret list`. It prints names and metadata. It never prints a value.
- `herdr-boss secret remove NAME`. It asks for the name typed again. It overwrites `NAME.sealed` and `NAME.sealed.prev` before it deletes them. It deletes the sealed backups and the journal of that label.
- `herdr-boss secret check [NAME]`. It decrypts each value in memory and checks the format. It prints `ok` or `failed` for each name. It never prints a value.
- Every command writes one audit line with the name, the action, and the time. The line holds no value.

### Account commands

- `herdr-boss account list`. It prints the accounts, the active one for each tool, and the quota reading of each account.
- `herdr-boss account use PROVIDER LABEL`. It swaps the login in opencode and in pi in one operation. For provider `opencode-go`, the operation does these steps:
  1. Take the account lock. The lock holds a PID and a start time, so a stale lock is detected. Refuse when another swap runs. `worker start` for the kinds `opencode` and `pi` waits for this lock.
  2. Check that no `opencode` or `pi` process of the user runs. This covers workers, orchestrator panes, and the Owner session. Refuse when one runs, unless the Owner passes `--allow-running`.
  3. Check the overrides that the probe names: environment variables and `apiKey` fields. Refuse when an override exists. This step changes nothing.
  4. Write back the login of the active label. The tools can refresh a login in place, so the stored value can become old. Compare the hash of the live entry with the stored hash of the entry that the last swap wrote. If the hashes are equal, do not write back. If they differ, write back only when the identity field that slice 1 names has the same value in the live entry and in the stored entry. The comparison runs in memory and prints nothing. In every other case, refuse with exit code 1 and tell the Owner to run `secret set`. A hand swap is one of these cases. If slice 1 finds no stable non-secret identity field, every case with different hashes refuses in this way. A write-back keeps the old stored value as `NAME.sealed.prev`.
  5. Write a sealed swap journal. It names the backups and the target label. Seal each backup of a live login entry with the master key in the store format.
  6. Read the login file of the tool. Replace only the OpenCode Go entry (for pi, only the matching provider entry). Keep all other keys unchanged. Write the result to a temporary file in the same directory as the target. Set mode 0600. Call `fsync`. Rename the temporary file over the target.
  7. Verify opencode with `opencode run` and a one-word prompt on a model of the account. Verify pi with one print-mode call. Step 2 confirms the exact pi flags. No verification call takes a value as an argument or in the environment.
  8. Read the login file again after the verification. Roll back when a tool wrote the file after the replace in step 6 and the entry is not the new one.
  9. Roll back both tools from the sealed backups when one verification fails. Verify again after the rollback.
  10. Post one Mailbox item on a failure. The item names the label and the failed tool. It holds no value.
- A refusal in step 1 to 4 changes nothing and releases the lock. A rollback is not a refusal.
- The journal exists only while a swap is open. Delete it when the swap ends with a verified result: the new login, or the old login restored. Delete the backups after a verified swap. After a failed swap, keep the backups until the next verified swap or until `secret remove` of the label. If the rollback does not verify, keep the journal also.
- On the next start of the service and on the next `account use`, the command reads the journal if one exists. It completes the swap or rolls it back. A kill between two renames therefore leaves no mixed state.
- The verification calls use quota. Each swap costs two small calls.
- The command prints the label, the result of each step, and the exit code. Exit code 0 means both tools use the new login. Exit code 1 means the swap failed and the old login is restored, or a refusal in step 3 or 4. Exit code 3 means the command refused because a process runs. Slice 3 and slice 4 define the exit codes of a refusal in an agent pane and of a held lock.

## 4. Rotation rules

Rotation is a rule in the engine tick. It uses the existing pacing goals.

### Existing pieces

- `pacingGoal(policy, provider, key)` returns the goal percent of a quota window (`src/control.js:695`). `pacingGoalEnd` returns the goal end time (`src/control.js:701`).
- The quota state has one reading for each provider. The OpenCode Go provider key is `opencodego` (`src/control.js:576`). A second subscription has no place in this state today.
- `validateAccounts` accepts one account for each harness and refuses a repeated harness (`src/fleet-quotas.js:7` to `src/fleet-quotas.js:18`). `provisionAccount` (`src/fleet-quotas.js:20`) replaces the record of the same harness. Slice 6 changes both. The Fleet summary quota row carries `harness`, `accountKey`, `lane`, `usedPercent`, `resetAt`, and `status` (`docs/contracts/examples/fleet-summary.valid.complete.json`).
- The `opencodego` quota comes from the external `codexbar` command (`src/collect.js:13`, `src/collect.js:254`). A Linux factory has no CodexBar (`src/collect.js:234`). Slice 6 traces the reader first.

### Per-account reading

- Add an account label to each quota reading. The reading key becomes provider plus label.
- Both subscriptions show on the Analytics view, one lane for each label.
- The inactive account needs a reading without a swap. The rule for a value in section 2 applies: the reader gets the value through stdin or a file descriptor only. If `codexbar` accepts neither, the inactive account shows the last known reading and its reset time. The Owner can enter a known reset time by hand for the second subscription.
- A Linux factory has no per-account reading until a Linux reader exists.
- `validateAccounts` accepts several accounts for one harness when the labels differ. The account key HMAC stays the same (`src/fleet-quotas.js:24`).
- The serving harness kinds of the OpenCode Go lane are `opencode` and `pi` (`src/config.js:171`). Each rule in this note covers both kinds.

### Swap rule

Rotation starts a swap from the active account A to the other account B when all of these conditions hold:

1. The rotation setting is on.
2. The usage of A in its goal window is at or above its pacing goal, or A is exhausted.
3. B has an open window: its usage is below its goal in the same window key as A, or its reset time has passed. The reading of B is younger than 6 hours, or the reset time of B has passed. With more than two accounts, rotation picks the account with the lowest usage as a share of its goal.
4. No `opencode` or `pi` process of the user runs, or the Owner allowed a swap with running processes.
5. The last swap is older than a minimum interval of 6 hours. This stops swapping back and forth.

The window key is the 5-hour, week, or month window that the policy names for the provider.

When condition 4 fails, rotation waits. The tick checks again. Rotation posts one Mailbox item that says running processes may keep the old login until they end (an unverified claim, see "Facts and gaps"). Rotation never stops a process.

Rotation never starts a swap when only one account has a reading. It never swaps to an account whose last verification failed.

## 5. Factories

- A secret belongs to one factory. It never leaves that factory (`docs/specs/factories.md`, user stories 72 and 78: "secrets and logins stay at the source", "host secrets, SSH keys, and fleet credentials stored where agents must not read them").
- A project transfer never moves a secret. The target asks again in the wizard (`docs/specs/factories.md`, "Project transfer").
- The head office may track these facts: the `accountKey` of each account, the provider, the expiry date, the verification result, and quota readings (`docs/specs/factories.md`, section "Fleet summary and credentials"). The label stays in the factory.
- The head office never receives a value, a login file path, a label, a secret name, or an account identity. The Fleet summary allow-list test must fail when a secret field appears (`docs/specs/factories.md`, user story 48). The contract fixtures `fleet-summary.invalid.account-identity.json` and `fleet-guidance.invalid.account-identity.json` already name this rule.
- Step 2 adds to the Fleet summary only the fields that the allow-list names: a list of `accountKey`, provider, expiry, and verification result. The schema only adds fields (`docs/specs/factories.md`).
- A transfer of a value between factories needs a command that the Owner runs at a terminal: `herdr-boss secret export NAME --to FACTORY`. The command prompts for a typed confirmation. It decrypts the value in memory. The target seals it again with the master key of the target. The value goes over `ssh` stdin and never through the head office, the Mailbox, or a pane. This command is optional. Step 2 builds it only when the Owner accepts decision 4.
- The account scope in the factories spec limits which factories may use an account (`docs/adr/0011-factory-shares-and-guidance.md:11`). A factory reads a secret only when its factory id is in the scope of the account.

### Conflict with a recorded Owner decision

The Owner decision of factories round 1 is "one OpenCode Go subscription per factory" (`docs/orchestration/memory.md`, entry of 2026-10-02 09:40). The factories spec records that one subscription has the Mac factory in its scope and one has the Windows factory (`docs/specs/factories.md`, Further Notes).

Rotation on factory zero needs both subscriptions in the account scope of factory zero. With the recorded scopes, factory zero reads one subscription only, and rotation cannot run. A swap onto the subscription of the Windows factory also takes its share from the Windows factory. Decision 6 asks the Owner to resolve this.

## 6. Dashboard

- Settings gets a section "Accounts and secrets". It follows the rule that each managed resource is visible and settable (`AGENTS.md`, Documentation).
- The section lists each secret name with provider, label, quota window, last used, and expiry. It never shows a value.
- The section shows the active account of opencode and of pi.
- The section edits the metadata of a secret: label, provider, and expiry. It removes a secret after a typed confirmation of the name.
- A toggle "Rotate accounts automatically" sets the rotation. The default is off.
- A button "Swap account" starts `account use`. A confirm step names the label, the tools, and the effect on running processes. The button is disabled while a swap runs.
- The swap route needs the access token. It refuses in `--read-only-preview`. The `fleetGuide` credential cannot reach it.
- The dashboard cannot set or read a value. The Owner sets a value only with `secret set` at a terminal. This is the recorded reason that values stay outside the dashboard. The page help in `HELP` in `public/app.js` says this.
- The Analytics view shows one quota lane for each label.
- The access token file and the secret values stay outside the dashboard, as a recorded reason (`AGENTS.md`, Documentation).

## Slices for step 2

Each slice fits one worker. Each slice has tests with temporary `HOME` and `HERDR_BOSS_DIR` fixtures. No test reads a real login.

1. Probe and docs. Add `account probe` with the refusal in an agent pane. Record the verified file paths, key names, and overrides of opencode and pi in `docs/harness-setup.md`. Verify the five facts of "Facts and gaps", and name the identity field for the write-back. If no stable non-secret identity field exists, record that, and slice 4 implements the refusal. Decide the method that detects an agent pane. Needs the Owner to run the command.
2. Store. Add the sealed file format, the index, the master key for macOS and Linux, and unit tests for the format, the mode, a wrong key, a renamed file, and a master key outside the backup volume.
3. Secret commands. Add `secret set`, `list`, `remove`, `check`, the audit line, and the refusal in an agent pane. Use the method of slice 1 for the agent pane. Test that stdin is the only input and that no output holds a value.
4. Account use for opencode. Add the lock with PID and start time, the override check, the write-back with the hash and identity check and the `.sealed.prev` copy, the sealed backup, the swap journal and its end of life, the single-entry write, the atomic write, the verification, and the rollback. Use a fake `opencode` binary in the fixture.
5. Account use for pi. Add the same steps for pi, and the joint rollback of both tools. Use a fake `pi` binary.
6. Quota per account. Trace the `opencodego` reader. Add the label to the quota reading. Change `validateAccounts` and `provisionAccount`. Update the Fleet contract and its examples.
7. Rotation rule. Add the engine rule, the minimum interval, the wait for running processes, and the Mailbox item.
8. Dashboard. Add the Settings section, the toggle, the swap button with the confirm step, the Analytics lanes, and the `HELP` text.
9. Docs and gate. Update `docs/cli.md`, `docs/user-guide.md`, and `docs/quota-plan.md`. Run the docs gate.

## Decisions for the Owner

Each decision has an Accept option and a Deny option.

### Decision 1: where the master key lives

- Accept: the file store with the master key in the macOS keychain (keychain key). On Linux the master key is a 0600 file (file key) outside the volume that `factory backup` copies.
- Deny: the file store with the master key in a 0600 file on all platforms. A Time Machine copy of the home folder on macOS then holds the store and the key, so the store gives no protection against threat 3 in that case.
- Recommendation: Accept. On macOS, a copy of the store directory is then useless without the keychain. On Linux, a backup of the `home` volume must not hold the key, so the key path is outside that volume.

### Decision 2: rotation default

- Accept: the rotation setting is off by default. The Owner turns it on in Settings.
- Deny: the rotation setting is on by default after the first account is stored.
- Recommendation: Accept. A swap changes the login of every tool. The Owner should choose when it starts.

### Decision 3: per-factory secrets

- Accept: each secret stays in the factory that holds it. The head office tracks the `accountKey`, provider, expiry, verification result, and quota readings only.
- Deny: the head office also stores sealed values and sends them to factories. Deny changes the factories spec (user stories 72 and 78).
- Recommendation: Accept. This matches the factories spec and keeps a head office takeover harmless.

### Decision 4: transfer of a value between factories

- Accept: build `secret export NAME --to FACTORY` as an Owner terminal command with a typed confirmation.
- Deny: build no transfer command. The Owner runs `secret set` in each factory.
- Recommendation: Deny for the first release. The Owner has two subscriptions and two factories, and `secret set` in each factory is enough.

### Decision 5: swap while a process runs

- Accept: rotation waits until no `opencode` or `pi` process of the user runs. A manual swap may pass `--allow-running`.
- Deny: rotation never waits. It starts a swap at once and running processes may keep the old login until they end.
- Recommendation: Accept. A wait avoids a mixed state in one project. The claim that a running tool keeps the old login is unverified until slice 1 verifies it.

### Decision 6: account scope of the OpenCode Go subscriptions

- Accept: both OpenCode Go subscriptions have factory zero in their account scope. The Windows factory keeps the second subscription in its scope, so the Windows factory and the Mac share that subscription. The Owner sets the factory shares so that the shares of each subscription total at most 100. Accept changes the recorded Owner decision "one OpenCode Go subscription per factory".
- Deny: keep one subscription for each factory. Rotation stays off for OpenCode Go, and the Owner swaps by hand.
- Recommendation: Accept. The FS1 goal is rotation between the two subscriptions on factory zero, and rotation needs both in scope.
