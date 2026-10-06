# Factories exchange contracts

These contracts define the files that factory tools exchange.
Build the factory tools around Herdr Boss.
Do not import the engine into the host tool.
Keep each factory responsible for its own work and access.

Use [the personal fleet spec](../specs/factories.md) as the build scope.
Use [the glossary](../CONTEXT.md) for terms.
Use ADRs [0002](../adr/0002-host-tool-in-herdr-boss.md),
[0011](../adr/0011-factory-shares-and-guidance.md),
[0016](../adr/0016-item-titles-per-factory.md),
[0019](../adr/0019-head-office-moves-to-windows.md),
[0021](../adr/0021-first-plan-is-the-personal-fleet.md), and
[0022](../adr/0022-manual-succession-first.md) for scope and safety rules.
The succession list, join exchange, and viewer allow-list are reserved contracts.
They do not add those features to the first build.

## Rules for all contracts

Use JSON Schema draft 2020-12.
Each schema file has a unique `$id` and a `version` annotation.
Its `description` states the version.
The initial version is **1.0.0**.
Each exchanged document has `schema: 1` and a `contractVersion`.
`schema` is the major contract number.
`contractVersion` is the contract version, not the factory software version.

Bump the contract version for every contract change.
Within a major version, add optional fields only.
Do not remove a field or change its meaning, type, bounds, or required state.
Do not add enum values that an old consumer cannot process.
Use a new major number for such a change.
Update the `$id`, version annotation, description, examples, and tests together.
Keep the old major schema when a consumer still uses it.

Validate the producer output before an exchange.
Validate the consumer input before use.
Use the same contract and version in both tests.
Run `node --test --test-concurrency=2 test/factory/contracts.test.js`.
The tests read the public example files through the local schema validator.
Future producer and consumer tests must also check their real file or HTTP boundary.
These fixture tests do not prove that a service uses the contracts.

Every object schema has an explicit field list.
The producer rejects fields outside that list.
This rule also applies to nested objects.
An old fleet reader may ignore new optional fields in the same major version.
It first checks the major number and contract version.
It then selects only the fields of its supported schema.
It validates that selection against the supported schema.
It does not render, store, or forward the omitted fields.
It shows `head office older` or `factory older` from the version comparison.
Other consumers refuse an unsupported revision until they support it.
They do not apply a partial control record.

Refuse malformed JSON and an unsupported major version.
Refuse the entire input when schema validation fails.
Do not change the last accepted record on a refusal.
Do not print the rejected body in an error.
An HTTP exchange returns 400 for an invalid document.
It returns 409 for a state conflict.
A file importer reports the contract name and field error, then stops.
The status codes here are requirements for future implementations.

The schema tests check shape and value bounds.
They do not check identity, signatures, permissions, expiry, or current state.
Perform those checks at the consumer boundary before any action.
Do not treat a valid example as authorization.

## Fleet summary

**Purpose:** Give the head office a small, allow-listed view of one factory.
**Producer:** The factory summary serializer at `GET /api/fleet/summary`.
**Consumer:** The head office poller and Fleet page.
**Version:** 1.1.0; major schema number 1.
**Schema:** [fleet-summary.v1.schema.json](schema/fleet-summary.v1.schema.json).
**Sources:** Tickets [16](../tickets/factories/16-fleet-summary.md) and
[17](../tickets/factories/17-head-office-fleet-page.md).

**Producer notes:** The login check uses the harness verifier and recorded login-state file metadata.
Pending login waits come from current matching Mailbox items.
Disk readings come from the machine snapshot.
The clock offset comes from the latest machine sample.
The summary uses the supplied factory kind.
The head office supplies the registered kind for a remote factory.

| Field | Content |
|---|---|
| `factoryId`, `name` | Stable factory identity and display name. |
| `version`, `kitRevision` | Factory software version and kit revision. |
| `generatedAt`, `dashboardUrl` | UTC creation time and dashboard base URL. |
| `health` | State, tick age, Herdr reachability, and clock offset. |
| `machine` | Load, CPU count, memory, and swap readings. |
| `projects` | Slug, phase, state, status age, kit revision, and board counts. |
| `claudeUsageHelper` | Optional. A container factory sets it. `state` is `installed` with `lastReadingSeconds`, or `not-installed` with `reason`. `reason` is `setting-off`, `different-statusline`, `settings-unreadable`, or `no-reading`. |
| `quotas` | Harness, account HMAC digest or the local marker, lane, use, reset time, state, and an optional `estimate`. |
| `spend` | Day, role, harness, and USD amount. |
| `alerts` | Public alert code, severity, and optional project slug. |
| `shareItemTitles`, `ownerItems` | Title sharing flag, counts, item IDs, kinds, and optional titles. |
| `reviewPacks` | Waiting pack IDs and waiting item counts. |

The optional 1.x additions are add-only.
An older summary omits them and stays valid.
An old reader selects only its supported fields.

| Field | Meaning, unit, and allowed values |
|---|---|
| `kind` | The factory runtime kind. Allowed values are `native`, `container`, or `null` when unknown. |
| `workers` | Worker counts. `running` and `max` are counts of at least 0, or `null` when unknown. |
| `harnesses` | Login checks. Each entry has `harness`, `login`, and `checkedAt`. |
| `harnesses[].login` | The login state. Allowed values are `ok`, `expired`, and `unknown`. |
| `harnesses[].checkedAt` | The UTC time of the check, or `null` when unknown. |
| `boss` | Boss availability as a fact. `running` is a boolean or `null`. `harness` is a harness name or `null`. |
| `pending` | Factory-verified Owner waits. Each entry has `step` and `since`. |
| `pending[].step` | The wait step as a slug, for example `login-claude`. |
| `pending[].since` | The UTC time the step started, or `null` when unknown. |
| `machine.diskFreePercent` | Free disk space as a percentage from 0 to 100, or `null`. |
| `machine.diskFreeMb` | Free disk space in megabytes, a number of at least 0, or `null`. |
| `machine.utcOffsetMinutes` | The local UTC offset of the factory in minutes, a signed number, or `null`. |
| `backup.lastAt` | The UTC time of the last backup, or `null` when the head office does not know it. |
| `ownerItems.rows[].projectSlug` | The project of an Owner item. Omit the field for a factory-level item. |
| `quotas[].accountKey` | The HMAC digest of a shared account. Optional only when `accountScope` is `this-factory`. A row has `accountKey` or `accountScope`, never both, never neither. |
| `quotas[].accountScope` | Optional. The closed value `this-factory`. The row comes from this factory and has no account record. It has no `accountKey`. The human text is "no account key". |

A new field holds no path, token, account identity, message text, login output, or command output.

**Add-only rules:** Add optional summary fields within the major version.
Update the producer allow-list before publishing a new field.
An old consumer uses the selection rule above.

**Error and refusal behavior:** Keep the last good summary after a poll failure.
Show its age.
Refuse a second factory with an accepted `factoryId`.
Titles are permitted only when `shareItemTitles` is true.
Message text, local paths, tokens, account identities, and command output are forbidden.
Use `null` for an unavailable reading.
Do not turn an unavailable reading into zero.
Poll every 30 seconds.
The read credential permits the summary and health routes only.
Refuse other routes with 403.
Keep the previous credential valid for 10 minutes after rotation.
The head office poll result is local dashboard data. It is not an exchanged summary contract.
It adds `lastSeenAt`, the UTC time of the last successful summary poll.
A failed poll keeps that time and the last good summary.
Before a successful poll, that time is unavailable.
Use the public error codes `unreachable`, `timeout`, `auth`, and `contract-mismatch` for HTTP poll failures.
Keep identity and registry refusal codes separate.
Do not include the rejected response body or transport error text.
The target summary size is 5 to 20 KB.
The schema does not set a minimum byte size.

**Example files:** `fleet-summary.valid.personal.json`,
`fleet-summary.valid.titles-off.json`, `fleet-summary.valid.unknown-readings.json`,
`fleet-summary.valid.transferred.json`, `fleet-summary.valid.complete.json`,
`fleet-summary.valid.minimal.json`, `fleet-summary.valid.nulls.json`,
`fleet-summary.valid.opencode-estimate.json`, `fleet-summary.invalid.estimate-percent.json`,
`fleet-summary.invalid.title-with-sharing-off.json`, and
`fleet-summary.invalid.message-text.json`,
`fleet-summary.valid.claude-helper-installed.json`, `fleet-summary.valid.claude-helper-not-installed.json`,
`fleet-summary.valid.local-quota.json`,
`fleet-summary.invalid.claude-helper-unknown-reason.json`, `fleet-summary.invalid.claude-helper-installed-with-reason.json`,
`fleet-summary.invalid.claude-helper-negative-age.json`, `fleet-summary.invalid.account-key-and-scope.json`,
`fleet-summary.invalid.account-key-missing.json`, and `fleet-summary.invalid.account-scope-unknown.json` in [examples/](examples/).
The complete example sets every 1.x addition.
The minimal example is an older summary without them.
The null example uses an unavailable reading.
The quota `estimate` is optional. It holds `days`, `tokens`, `costUsd`, and `omittedModels`. A factory sets it for a harness without a usage source, for example OpenCode Go. The row then has `usedPercent: null` and `status: unknown`. The estimate is the local use in that factory. It is never a percent and never a quota. `resetAt` of that row is the reset time that the Owner set by hand.
A factory with no account record for a harness still reports that harness from its own readings. Each row then has `accountScope: "this-factory"` and no `accountKey`. The schema accepts the row. A head office on contract 1.0.0 refuses a summary that holds such a row, because its schema requires `accountKey`. Update the head office before the factories. The Fleet card labels the row `this factory only`.

### Rollup

Build the Fleet rollup from accepted summaries and one injected time. Include only known readings from summaries that are at most 90 seconds old in totals. Name cached, never-seen, unknown, and unpriced readings in coverage. Do not count an unknown reading as zero. Show cached values only with their summary age. Select one spend day for each factory. If today's factory-calendar row is missing, use the latest factory day and show its date. Use the highest fresh value for each shared quota lane. Leave a row with the `this-factory` marker out of the shared quota total. Show that row on the factory card with the label `this factory only`.

## Head office role record

**Purpose:** Identify the current head office term.
**Producer:** The manual `hub promote` command after Owner confirmation.
**Consumer:** Each factory and the former head office.
**Version:** 1.0.0; major schema number 1.
**Schema:** [head-office-role.v1.schema.json](schema/head-office-role.v1.schema.json).
**Source:** Ticket [19](../tickets/factories/19-head-office-role.md).

The record holds `headOfficeFactoryId`, `epoch`, and `updatedAt`.
The first epoch is 1.
**Add-only rules:** Add optional metadata only.
Do not change the epoch rules within this major version.
**Error and refusal behavior:** Refuse an unknown or ineligible holder.
A promotion uses the accepted epoch plus one.
Refuse a lower epoch or a different holder at the same epoch.
Accept an exact repeat without a second promotion.
The former holder stops polling and sending guidance after the switch.
Move the registry and factory shares with the role.
Refuse guidance below the highest accepted epoch.
Move the role from factory zero only after the required seven clean days.
This record does not implement an automatic election or a lease.

**Example files:** `head-office-role.valid.manual.json` and
`head-office-role.invalid.zero-epoch.json` in [examples/](examples/).

## Succession list

**Purpose:** Reserve the Owner-signed order of eligible factories.
**Producer:** The Owner's signing tool.
**Consumer:** A future head office move or election verifier.
**Version:** 1.0.0; major schema number 1.
**Schema:** [succession-list.v1.schema.json](schema/succession-list.v1.schema.json).
**Source:** The glossary and the later design in
[proposal section 16](../ideas/factories.md#16-head-office-as-a-role-handover-and-succession-version-2).

The record holds `listId`, `issuedAt`, `entries`, and `ownerSignature`.
Each entry binds `factoryId`, `rank`, and `factoryKeyId`.
Rank 1 has the highest priority.
An empty list means that no standby is eligible.
`ownerSignature` names the algorithm, anchor key ID, and detached signature reference.
It contains no key material.
**Add-only rules:** Add optional metadata only.
Do not change rank order or signature meaning within this major version.
**Error and refusal behavior:** Refuse a missing or invalid detached signature.
Verify the signature against the Owner's trusted anchor.
Sign the document without the `ownerSignature` field.
Serialize the signed content as UTF-8 compact JSON with recursively sorted object keys.
Preserve array order.
Refuse duplicate factories, ranks, or factory key IDs.
Refuse a client-premises factory or a host that sleeps.
Factory zero on the Mac is never a standby.
Do not replicate enrolment tokens with this list.
The personal fleet build uses manual promotion only.

**Example files:** `succession-list.valid.ranked.json`,
`succession-list.valid.no-standby.json`, and
`succession-list.invalid.unsigned.json` in [examples/](examples/).
The signature references in these examples do not point to real signatures.

## Fleet join request

**Purpose:** Reserve a request to enrol a factory.
**Producer:** A future `fleet join` command in the joining factory.
**Consumer:** The confirmed head office enrolment handler.
**Version:** 1.0.0; major schema number 1.
**Schema:** [fleet-join.v1.schema.json](schema/fleet-join.v1.schema.json).
**Source:** [Proposal section 8.5](../ideas/factories.md#85-enrolment-and-trust).

The request holds `requestId`, `invitationId`, `factoryId`, `name`,
`dashboardUrl`, and `requestedScopes`.
Only `fleetRead` and `fleetGuide` are permitted.
Send the secret join token in the authenticated provisioning channel.
Do not put it in this JSON document.
The invitation ID is a lookup reference, not a credential.
**Add-only rules:** Add optional request metadata only.
A new credential scope requires a new major contract.
**Error and refusal behavior:** Authenticate before accepting a request.
Refuse an invitation that is invalid, used, or more than 15 minutes old.
Consume an invitation once, with the enrolment transaction.
Refuse a duplicate `factoryId` or repeated scope.
Do not permit a temporary head office to enrol factories.
Do not issue a credential on a refused join.

**Example files:** `fleet-join.valid.request.json` and
`fleet-join.valid.port-65535.json`, `fleet-join.invalid.write-scope.json`,
`fleet-join.invalid.port-zero.json`, `fleet-join.invalid.port-65536.json`, and
`fleet-join.invalid.port-99999.json` in [examples/](examples/).

## Fleet enrolment result

**Purpose:** Report an accepted or refused join without exporting credentials.
**Producer:** The head office enrolment handler or initial host provisioning tool.
**Consumer:** The joining factory and the head office credential store.
**Version:** 1.0.0; major schema number 1.
**Schema:** [fleet-enrolment.v1.schema.json](schema/fleet-enrolment.v1.schema.json).
**Source:** The spec credential rules and the join proposal above.

Both results hold `requestId` and `status`.
An `enrolled` result holds both factory IDs, the epoch, and `credentialRefs`.
Each reference holds the scope, opaque credential reference, issue time, and expiry time.
`previousValidUntil` is optional rotation metadata.
A `refused` result holds one refusal `code`.
The schema rejects a mixture of the two results.
Deliver credential bytes through private provisioning, outside this document.
**Add-only rules:** Add optional result metadata only.
Do not add a scope or change a refusal code within this major version.
**Error and refusal behavior:** Match the result to the pending request and factory.
Refuse an old epoch, expired credential, repeated scope, or unknown reference.
The expiry must follow the issue time.
The previous credential expires 10 minutes after rotation.
Use 401 for an invalid invitation credential.
Use 403 for a refused scope or an unconfirmed head office.
Use 409 for a used invitation or duplicate factory.
Refuse a result that cannot be matched to its provisioning channel.
Do not fetch credential references from an arbitrary URL.

**Example files:** `fleet-enrolment.valid.enrolled.json`,
`fleet-enrolment.valid.refused.json`, and
`fleet-enrolment.invalid.mixed-result.json` in [examples/](examples/).

## Viewer route allow-list

**Purpose:** Reserve the complete route list of the separate viewer listener.
**Producer:** The viewer route configuration writer.
**Consumer:** The separate viewer handler and its permission checks.
**Version:** 1.0.0; major schema number 1.
**Schema:** [viewer-routes.v1.schema.json](schema/viewer-routes.v1.schema.json).
**Source:** [Proposal section 17](../ideas/factories.md#17-users-roles-and-access-version-2).

Each route binds one method, path template, and permission.
The initial list permits only these combinations:

| Method | Path | Permission |
|---|---|---|
| GET | `/` | `state.read` |
| GET | `/api/viewer/state` | `state.read` |
| GET | `/api/viewer/boards/{project}` | `boards.read` |
| GET | `/api/viewer/packs/{id}` | `packs.read` |
| GET | `/api/viewer/items` | `items.read` |

**Add-only rules:** Add optional configuration metadata only.
A new route or permission requires a new major contract.
**Error and refusal behavior:** Refuse duplicate method and path pairs.
Return 404 for an unlisted route or method.
Apply the permission and local factory or project grant to each listed route.
Show only items and packs addressed to the user.
Use a separate handler, cookie, session store, and page.
Do not import the main server or use its loopback authorization bypass.
Do not show transcripts, paths, spend, settings, credentials, or other projects.
Do not mount the main dashboard assets on this listener.
The allow-list does not define a viewer response schema or build the listener.

**Example files:** `viewer-routes.valid.read-only.json`,
`viewer-routes.invalid.owner-route.json`, and
`viewer-routes.invalid.write-method.json` in [examples/](examples/).

## Project transfer bundle

**Purpose:** Describe one small-form transfer through GitHub.
**Producer:** The frozen source factory transfer exporter.
**Consumer:** The target factory transfer importer.
**Version:** 1.0.0; major schema number 1.
**Schema:** [project-transfer.v1.schema.json](schema/project-transfer.v1.schema.json).
**Source:** Ticket [20](../tickets/factories/20-project-transfer.md).

The bundle is a manifest.
It holds `transferId`, both factory IDs, `createdAt`, `kitRevision`,
the project record, a GitHub repository reference, and `sourcePointers`.
The repository reference holds a transfer branch and exact commit.
Committed `memory.md`, briefs, and status travel through GitHub.
Source pointers hold a dashboard base URL and item or pack IDs only.
Owner items, packs, messages, logins, and secrets stay at the source.
The project `status` value `transferred` marks a project that the source has switched away.
**Add-only rules:** Add optional manifest metadata only.
A full archive with board, ledger, or access records needs a later contract.
**Error and refusal behavior:** Refuse equal source and target IDs.
Refuse an unknown target, a kit mismatch, or a repository outside GitHub.
Refuse unpushed work before the freeze.
The target must fetch the named commit from the named branch.
Do not turn a repository reference into an arbitrary URL or local path.
Keep the transfer lock on both factories until switch or cancel.
The bundle does not authorize a switch or unlock worker dispatch.
Close the source orchestrator before starting the target orchestrator.
Require the target checks and Owner confirmation before the switch.
Cancel before the switch removes the target clone and project record.
Keep an audit entry on each factory.

**Example files:** `project-transfer.valid.small-form.json`,
`project-transfer.valid.transferred.json`,
`project-transfer.invalid.message-text.json`, and
`project-transfer.invalid.unpinned-commit.json` in [examples/](examples/).

## Factory registry file

**Purpose:** Give the host tool a secret-free inventory.
**Producer:** The host tool registry writer.
**Consumer:** The host tool commands and a confirmed head office move.
**Version:** 1.0.0; major schema number 1.
**Schema:** [factory-registry.v1.schema.json](schema/factory-registry.v1.schema.json).
**Sources:** Tickets [09](../tickets/factories/09-host-tool-core.md) and
[11](../tickets/factories/11-ssh-transport.md).

The file holds `minimumFactoryVersion`, `hosts`, and `factories`.
A host record holds its ID, runtime, personal-use flag, and Codex sandbox setting.
A `local` host has no remote address.
An `ssh` host also holds its address and Docker context name.
An `ssh` host can instead hold `connectionRef`.
This field names a record in the private connection store.
This add-only form keeps the address, key path, and context name outside the fleet file.
The earlier forms stay valid.
The address is a DNS name or a single-label tailnet name.
Neither record holds an SSH key, key path, or credential.
The private connection store is `registry.json` in the host tool folder.
The fleet registry is `fleet.json` in that folder.
Do not send the private connection store to a head office.
A factory record binds its ID and name to a host and profile.
It holds the dashboard base URL, software version, and kit revision.
A container factory also has its container name, loopback ports, and image metadata.
It can hold the container hostname that the host tool sets at creation.
Image metadata holds the build time and pins hash.
The native factory record needs no image or container ports.
**Add-only rules:** Add optional record metadata only.
New transports, runtimes, or profiles require a new major contract.
**Error and refusal behavior:** Refuse duplicate host IDs, factory IDs, or factory names.
Refuse an unknown host reference or colliding host ports.
Refuse a client profile on a personal-use-only runtime.
The first build refuses all client factory creation.
Refuse a factory below `minimumFactoryVersion` for a command that needs that version.
Use version numbers, not text order, for the comparison.
Keep the last accepted file after a parse or validation error.
Write a new file with an atomic rename.
The host tool refuses to run inside a container.
Do not use a registry entry to bypass the live data directory check.
Keep the worktree and project root settings local to each factory.

**Example files:** `factory-registry.valid.local-and-ssh.json`,
`factory-registry.valid.single-label-host.json`,
`factory-registry.valid.connection-ref.json`,
`factory-registry.invalid.connection-ref-key.json`,
`factory-registry.invalid.port-range.json`,
`factory-registry.invalid.credential-path.json`,
`factory-registry.invalid.address-user-info.json`, and
`factory-registry.invalid.hostname-one-label.json` in [examples/](examples/).

## Fleet guidance

**Purpose:** Give a factory Boss the factory shares and nudges of the head office.
**Producer:** The head office guidance sender.
**Consumer:** The factory handler of `POST /api/fleet/guidance`.
**Version:** 1.0.0; major schema number 1.
**Schema:** [fleet-guidance.v1.schema.json](schema/fleet-guidance.v1.schema.json).
**Sources:** [ADR 0011](../adr/0011-factory-shares-and-guidance.md),
ticket [18](../tickets/factories/18-factory-shares-and-guidance.md), and the spec
section "Factory shares and guidance".

The body holds `headOfficeFactoryId`, `senderEpoch`, `sentAt`, `shares`, and `nudges`.
Each share binds an `accountKey` digest to a `share` from 0 to 100.
Each nudge holds a `nudgeId` and a `text` of 1 to 500 characters.
Both arrays are required. An array can be empty.
The body holds no policy, worker command, or credential field.
**Add-only rules:** Add optional guidance metadata only.
A new guidance kind requires a new major contract.
**Error and refusal behavior:** Accept the route only with the `fleetGuide` credential.
Refuse the `fleetRead` credential with 403.
Refuse a `senderEpoch` below the highest accepted epoch.
Refuse a `headOfficeFactoryId` that is not the holder of the accepted epoch.
The shares of one account must total at most 100 across the factories.
The schema cannot check that total. Check it at the head office before sending.
The factory checks only its own share against the account scope.
Keep the last accepted shares when the head office is offline.
Post each nudge to the factory Boss pane as an agent message.
The credential cannot change policy, start or stop workers, or read message text.

**Example files:** `fleet-guidance.valid.share-and-nudge.json`,
`fleet-guidance.valid.empty.json`, `fleet-guidance.invalid.share-over-100.json`,
`fleet-guidance.invalid.zero-epoch.json`, `fleet-guidance.invalid.account-identity.json`,
and `fleet-guidance.invalid.policy-field.json` in [examples/](examples/).

## Factory health body

**Purpose:** Report the liveness of one factory without a path or a secret.
**Producer:** The factory handler of `GET /api/health`.
**Consumer:** The head office poller and the host tool.
**Version:** 1.0.0; major schema number 1.
**Schema:** [factory-health.v1.schema.json](schema/factory-health.v1.schema.json).
**Source:** Ticket [06](../tickets/factories/06-factory-hostnames-health-log-rotation.md).

The body holds `version`, `kitRevision`, `tickAgeSeconds`, `herdrReachable`, and
`clockOffsetSeconds`.
The `schema` number and `contractVersion` identify the contract.
`version` is the factory software version.
Use `null` for an unavailable reading.
**Add-only rules:** Add optional reading fields only.
The fleet summary `health.status` value stays a head office judgement.
It is not part of this body.
**Error and refusal behavior:** The body holds no path, hostname, token, or log text.
Accept the route with the `fleetRead` credential.
Refuse an unknown field.
Keep the last good body after a poll failure.

**Example files:** `factory-health.valid.healthy.json`,
`factory-health.valid.unknown-readings.json`, `factory-health.invalid.path.json`,
`factory-health.invalid.negative-tick-age.json`, and
`factory-health.invalid.missing-reading.json` in [examples/](examples/).

## Factory backup archive

**Purpose:** Restore the data and work of one container factory.
**Producer:** The host command `factory backup NAME`.
**Consumer:** The host commands `factory restore FILE` and `factory destroy NAME`.
**Version:** 1.0.0; major schema number 1.
**Schema:** [factory-backup.v1.schema.json](schema/factory-backup.v1.schema.json).
**Source:** Ticket [14](../tickets/factories/14-backup-restore.md).

The `.hfb` file is a gzip stream.
Its first JSON line has `type: "manifest"` and a `value` object.
The value follows the manifest schema.
It holds the factory identity, UTC backup time, image metadata, ports, volumes, and resource owner label.
It holds no host address, key path, Docker context, or connection reference.
The private backup receipt holds the file path, UTC time, name, and SHA-256 checksum.
Do not copy that receipt into a repository.

Each next JSON line describes a directory, file, or symbolic link.
Each entry has `type`, `path`, and `mode`.
A file entry also has `size`.
Exactly `size` raw bytes follow its newline.
The next header starts directly after those bytes.
A link entry also has `target`.
A final line with `type: "end"` closes the archive.
No byte can follow that line in the decoded stream.
A header can hold at most 65536 bytes.
A path or link target can hold at most 4096 characters.
Modes are integers from 0 to 511.
File sizes are nonnegative safe integers.

Paths start with `data`, `work`, or the optional `home`.
The manifest lists the included volumes in that order.
A parent directory must appear before a child.
Refuse an absolute entry path, a duplicate, a traversal component, a backslash, or a null byte.
Refuse a child of a symbolic link.
Keep file bytes, permissions, and symbolic links.
Runtime sockets and devices are excluded.
The helper gives restored entries to UID and GID 1000.
The image startup script sets the SSH host key owner.

**Add-only rules:** Add optional manifest metadata only within this major version.
A framing change needs a new major format.
**Error and refusal behavior:** Validate the complete archive before a restore creates resources.
Require typed Owner confirmation for restore and destroy.
Require an empty target name and new volumes for restore.
Require a matching image and free registered ports.
Stop a running source for backup.
Use `VACUUM INTO` for each SQLite database in the data volume.
Exclude its journal sidecars.
Remove the archive helper by its exact name after each attempt.
Check its factory and worker labels first.
Perform this check also after a Docker timeout.
Restart the source only after helper cleanup.
Keep the source stopped if helper cleanup fails.
Keep a stopped source stopped.
The `code` volume comes from the matching image during restore.
The private host connection store is excluded.
Store every backup in a private folder outside repositories and cloud folders.
Use mode 600 for the backup file and mode 700 for its folder.
Destroy requires a matching checksum and a backup from the last 24 hours that includes home.
Refuse a backup without home and name `--include-home` in the error.
After a lost restore create reply, inspect the fixed target container and four volume names.
Remove only resources with matching factory and worker labels.
Remove the archive helper before volume rollback.
Keep a resource with different labels.
Keep the pending record when a label differs or cleanup cannot finish.
Remove only the named factory's container and four volumes with matching factory and worker labels.
Keep the image, builder, connection record, and backup.
A destroy retry skips resources already removed.
It checks all remaining labels before removal.

**Example files:** `factory-backup.valid.home.json` and
`factory-backup.invalid.address.json` in [examples/](examples/).
These files show manifest metadata only.
The command tests check the archive bytes and a SQLite restore.

## Shared value definitions

**Purpose:** Keep the contract value rules consistent.
**Producer:** The contract maintainers.
**Consumer:** All eleven exchange schemas.
**Version:** 1.0.0.
**Schema:** [common.v1.schema.json](schema/common.v1.schema.json).
This file defines values and is not an exchanged document.
The valid and invalid exchange examples test its local references.
**Add-only rules:** Add a new definition only.
Change an existing definition only in a new major version.
**Error and refusal behavior:** Refuse a missing reference or unsupported keyword.
Resolve references inside the schema directory only.
Do not fetch a schema over the network.

The test validator supports `type`, `properties`, `required`,
`additionalProperties`, `enum`, `const`, `items`, `minItems`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `oneOf`, and local `$ref`.
It also reads `$defs` and the schema documentation annotations.
It counts string length in Unicode code points.
It applies constraints beside `$ref`.
It requires exactly one successful `oneOf` branch.
It reports field paths without rejected values.
It refuses cyclic references.
Keep new schemas inside this subset.

## Decisions

The sources do not specify all wire fields.
These choices complete the initial contracts.

1. Use one major schema number and a separate contract version in each document.
   Keep the factory software version in `version`.
   Use stable `.v1.schema.json` file names for the current major version.
2. Use bounded slugs for IDs, phases, factory names, and references.
   Use lower-case hexadecimal digests for HMAC account keys and image pins.
   An account digest is not an account identity or signing key.
3. Use UTC time strings to whole seconds.
   Use date strings for spend days.
   The patterns check syntax only.
   Consumers must also check calendar validity and time order.
4. Use seconds for status age, tick age, and clock offset.
   Use megabytes for memory and swap.
   Use percentages from 0 to 100 for use and free memory.
   Use USD for spend.
   Use `null` when a reading is unavailable.
   Count fields do not exceed the largest safe JSON integer in Node.js.
5. Use public alert codes instead of free alert text.
   Use IDs for links to Owner items and review packs.
   Permit only dashboard base URLs without user information, paths, queries, or fragments.
   Consumers must also check that the URL belongs to the registered factory.
6. Require the title-sharing flag in the summary.
   Permit optional titles only when it is true.
   Keep all other summary objects closed to unknown producer fields.
   Use an explicit supported-field selection for an old fleet reader.
7. Keep the role record limited to the manual promotion fields.
   Reserve the succession list for the later design.
   Use an empty list when no standby is eligible.
   Use detached signature and key references instead of key bytes.
   Use sorted compact JSON as the signature input.
8. Split join into request metadata and result metadata.
   Keep invitation tokens and credential bytes in private provisioning.
   Use single-use invitations with the proposal's 15 minute limit.
   Use one refusal code instead of free error text.
   The personal fleet build still creates credentials through the host tool.
9. Reserve five viewer GET routes with fixed permissions.
   Give them a separate `/api/viewer/` prefix.
   Do not enable the deferred viewer feature from a schema file.
10. Define the small-form transfer bundle as a manifest.
    Transfer committed files through GitHub.
    Keep board, ledger, and access archives outside this initial contract.
    Store a repository owner and name instead of a private repository URL.
11. Use registry arrays of host and factory records.
    Support only the planned `local` and `ssh` transports.
    Record `client` as a reserved profile.
    Use separate native and container record shapes.
    Use `user-namespaces`, `unconfined`, or `unavailable` for the host sandbox result.
    Keep signing, host, and SSH credentials outside the registry.
12. Keep cross-record and current-state checks at the consumer boundary.
    This includes uniqueness, host references, port collisions, eligibility,
    signatures, expiry, epoch order, transfer locks, and Owner confirmation.
    The permitted schema subset cannot prove those conditions.
13. Use the state values `ready`, `doing`, `review`, `blocked`, `done`,
    `paused`, `transferred`, and `unknown` for a project.
    Use `ok`, `ahead`, `exhausted`, and `unknown` for a quota lane.
    Use `healthy`, `degraded`, `offline`, and `unknown` for health.
    A harness is an open identifier of 1 to 32 characters. Use lowercase
    letters, digits, and hyphens. Start with a letter. Consumers show an
    unknown harness as it is and never reject a summary for that value.
    The first image installs `claude`, `codex`, `opencode`, and `pi`.
14. Limit slugs and version strings to 64 characters.
    Limit titles to 160 characters and project display names to 80 characters.
    Limit dashboard base URLs to 300 characters and hostnames to 253 characters.
    Use 12 to 64 hexadecimal characters for a kit revision.
    Use 64 hexadecimal characters for a digest and 40 for a Git commit.
    Use ports from 1 to 65535.
    These limits are initial contract choices, not measured resource limits.
15. Add `transferred` to the project state before any release of contract 1.0.0.
    The source marks a project `transferred` after the Owner confirms the switch.
    The value is part of the first published enum, so no old consumer exists.
    A later enum change needs a new major contract.
16. Check the dashboard URL port in the pattern: no leading zero, 1 to 65535.
    The pattern lists the digit ranges because the validator subset has no port keyword.
17. Define `hostname` for DNS names that need a dot.
    Define `hostAddress` for an SSH host address.
    It accepts one label, such as a tailnet name, or a dotted name.
    Neither definition accepts user information, a port, or a path.
    The registry `address` uses `hostAddress`.
    The optional container `hostname` uses `hostname`, because the host tool sets a dotted name.
18. Define the guidance body with a required `shares` array and a required `nudges` array.
    Name the share key `accountKey` and limit each share to 0 to 100.
    Limit a nudge text to 500 characters.
    Check the 100 total per account at the sender and the account scope at the receiver.
19. Define the health body with the fields of ticket 06 and the standard document header.
    Keep the status judgement in the fleet summary.
