# Plan: project browsers on the resource lease pools

Built and merged on 2026-09-28 (V39). The Owner retired the port 9222 browser on 2026-09-28 (V40); it stays out of every pool. The rest of this file is the design record.

## Current state

- **Project browsers.** `src/browser-pool.js` keeps one record for each project in `browser-sessions.json`: port, profile folder, headless mode, window size, recorded PID, and code-sign clone. `requestBrowser()` picks a free port from 9223 to 9299, launches Chrome, and keeps the port for that project across sessions. The engine checks the state with a TCP connect, a process match (port flag and profile path), and a CDP `/json/version` probe.
- **Resource leases.** `src/leases.js` (V20) keeps short leases in `leases.json`. It reads pools from `config.json`. A lease has a holder (project, worker, pane), a TTL, and reclaim rules: pane gone, run finished, TTL passed, or no TCP listener after the grace time.
- **Port 9222.** `src/engine.js` lists port 9222 as "Protected legacy browser". No project owns it. Herdr Boss never stops it.

## Decision: move the project browsers, keep port 9222 out

The project browsers fit the lease model. Each browser is one item (a port) with one holder (a project). They need a holder with no pane and no TTL, because a project browser lives across sessions.

Port 9222 must not move. It is not a pool item. It has no project holder. A reclaim rule could remove its protection. It stays a fixed entry in the engine's browser list.

## Steps

1. **Holder type.** Add a lease holder of type `project` that has no pane, no worker, and no TTL. Only an explicit release or a failed health check reclaims it.
2. **Health reclaim.** Add a pool option `check: "cdp"`. It uses the existing checks of `browserStatus()`: the process match and the CDP probe. A `check: "cdp"` lease is reclaimed only when no matching Chrome process exists on two ticks in a row. A hung browser ("not responding") is not reclaimed. The Owner restarts it.
3. **Pool.** Add a built-in pool `project-browsers` with the range 9223 to 9299. Build it in code, not from `config.json`, so a config error cannot remove it. It has no split.
4. **Keep the browser data.** The lease holds only the port. The profile folder, window size, headless mode, recorded PID, and code-sign clone stay in `browser-sessions.json`, keyed by project.
5. **Request.** `requestBrowser()` acquires the lease with `prefer` set to the recorded port, so a project keeps its port and its profile. The dashboard and the CLI stay the same.
6. **Migration step.** A one-time step writes a lease for each existing record, with its current port. It runs once at engine start when `leases.json` has no `project-browsers` leases. It changes no port.
7. **Bulletin.** The "Resource leases" section lists the pool. The "Project browsers" section stays, because it has the browser state and the commands.
8. **Tests.** Cover the migration of the three current records, the preferred port, the two-tick CDP reclaim, a hung browser that is not reclaimed, and that port 9222 is never in the pool.

## Risks

- A wrong reclaim closes no browser, because leases never stop processes. But a wrong reclaim could give the port to another project while the old Chrome still listens. Step 2 requires a missing process on two ticks for this reason.
- Existing agents use the port from the bulletin. The migration keeps every port, so no agent sees a change.

## Order

Do this after V22 is merged, because both touch the startup path of workers and browsers.
