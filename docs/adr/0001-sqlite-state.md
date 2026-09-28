# ADR 0001: SQLite for Herdr Boss state

Status: proposed

## Context

One service and many CLI, worker, and dashboard callers share `~/.herdr-boss`. The runtime is Node 26.10.0. Herdr Boss has no dependencies, and this decision keeps that rule.

I did not inspect live data files. The size notes below describe code limits and growth, not current byte counts.

## Options

1. Keep JSON and JSONL. Files stay inspectable, but full-history scans and lost updates remain.
2. Move all state to SQLite. This adds transactions and indexes, but breaks file readers and needs migration and recovery.
3. Move shared records and histories. Keep editable settings and public file contracts as files.

### Inventory and pain

| File | Size, writers, write path, and observed pain |
| --- | --- |
| `events.jsonl` | Unbounded. The engine appends events. Startup reads the full file, then keeps 200 rows. Cost grows with the log. (`src/engine.js`) |
| `messages.jsonl` | The code keeps 30 days and shows 200 rows per thread, but reads the full file on each engine mailbox refresh and every write. The engine, CLI, and server append or rewrite under a `.lock`; rewrites use temporary files and rename. Scans grow with history. (`src/messages.js`, `src/server.js`) |
| `usage.jsonl` | Unbounded worker usage rows. Worker collection, CLI, and server append. Duplicate checks, summaries, and limited reads load the whole file. (`src/usage.js`, `src/kit/workers.js`, `src/server.js`) |
| `quota-history.jsonl` | Unbounded samples. The engine appends snapshots. Time-filtered reads scan the whole file; the trend view reads all rows before keeping 3,000. (`src/usage.js`, `src/engine.js`) |
| `leases.json` | Bounded by configured pool items, with at most 1,000 items per configured pool plus the built-in browser pool. The engine, CLI, server, and workers mutate it under the machine `.mutation` guard, then write a temporary file and rename it. V63 fixed a stale guard that could block lock and lease changes. The guard now recovers dead or old owners. (`src/leases.js`, `src/kit/locks.js`; commit `6be7c9b`) |
| `locks/<scope>/<name>.json`; `locks/machine/notices/*.json`; `.mutation/owner.json` | Lock records exist while held; notices remain until delivered; the owner record is transient. The CLI creates records exclusively and removes them under the guard. V63 fixed the stale-guard failure mode. These low-volume records duplicate database transaction work. (`src/kit/locks.js`) |
| `browser-sessions.json` | One entry per project browser, with at most 30 bookmarks per project. CLI and server commands read-modify-write the object through a process-specific temporary file and rename, without a shared guard. Concurrent updates can replace each other. (`src/browser-pool.js`, `src/server.js`) |
| `handoffs.json` | One record per handoff, including up to 20,000 characters of captured context. The CLI and engine update the full list through temporary files and rename, without a shared guard. The file has no retention cap, and concurrent updates can be lost. (`src/handoff.js`, `src/engine.js`) |
| `denials.json` | Aggregated counts have 30-day retention. The engine reads and rewrites the full file through a temporary file and rename every scan. It is bounded and has one normal writer. (`src/denials.js`, `src/engine.js`) |
| `memory.json` | Engine metadata; machine history is capped at 240 samples and other maps are pruned by age. The engine writes a temporary file and renames it. (`src/engine.js`) |
| `state.json`, `rules.json`, `bulletin.md` | Current snapshots sized by active projects, panes, and workers. The engine atomically replaces the JSON files and directly rewrites the Markdown bulletin. The CLI, server, and workers read these files, so keep them as export views. (`src/engine.js`, `src/server.js`, `src/kit/workers.js`) |
| `config.json`, `policy.json` | Small editable settings objects. The Owner edits them; the server and CLI also write them, and the engine can migrate policy fields. Writers use temporary files and rename, but concurrent read-modify-write saves can replace newer fields. Keep these files plain for Owner edits. (`src/config.js`, `src/control.js`) |
| `project-repos.json` | One row per registered project, so it grows with project count. The CLI reads and rewrites the full list through a shared `.tmp` name; concurrent first publishes can lose a row. The engine and harness tools read it. (`src/harness.js`) |
| `projects/<slug>.json` | One published project status per project. Size follows the current plan; validation sets no task-count cap. The CLI and server replace the full file through a shared `.tmp` name. Concurrent publishes can lose a newer status. Keep this JSON contract for orchestrators and other tools. (`src/projects.js`, `src/server.js`) |
| `server.log` | Service output grows until an external rotation policy acts. Launchd writes stdout and stderr here. This is a text log, not structured application state. (`src/cli.js`) |

Worker run records and delegated-run ledgers live in project repositories. Keep them and kit files in their current JSON, JSONL, and Markdown formats. Chrome owns browser profiles.

Node 26 provides built-in `node:sqlite`. `DatabaseSync` is synchronous. Its `timeout` option sets the busy timeout; the default is zero. Node 26.10.0 marks this API Stability 1.2, release candidate. Use `exec()` for short transactions and prepared statements for data. Use WAL for CLI and service readers, serialize the single writer, and set a bounded 5-second timeout. Synchronous waits can block the service event loop. The Node docs do not promise macOS file-lock behavior, so require a two-process macOS contention test on local storage. ([Node.js 26.10.0 SQLite docs](https://nodejs.org/api/sqlite.html))

## Decision

Recommend a partial migration. Migrate `messages.jsonl` first, then `events.jsonl`, then `leases.json` and the mutation guard. These files combine expensive full scans, shared writes, or custom cross-process locking. Migrate usage and quota history next if the first stages pass. Keep settings, published project status, snapshot views, logs, kit files, worker run files, and delegated-run ledgers as files.

## Consequences

Keep source files until import checks pass. Make imports idempotent. Export the old formats before downgrade. Back up with `sqlite.backup()` or `VACUUM INTO`; do not copy only the live database while WAL is active. Run `PRAGMA quick_check` at startup. On failure, stop writes and restore a verified backup or re-import preserved files. No npm dependency is needed, but the release-candidate API carries compatibility risk.

## Tasks

1. Add a small store with WAL, busy timeout, schema versioning, import/export, backup, corruption checks, and two-process macOS tests.
2. Move messages. Preserve retention, ordering, and CLI and dashboard contracts.
3. Move events, usage, and quota samples. Add indexed recent and time-range queries and explicit retention.
4. Move leases and lock records. Preserve ownership checks, expiry, stale-record recovery, and lock notices. Remove the file mutation guard only after transaction tests pass.
5. Add downgrade and restore procedures. Keep source files until the new store passes service, CLI, backup, corruption, and recovery checks.
