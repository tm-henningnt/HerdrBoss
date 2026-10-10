# Process facts API

The live service provides three read-only routes on loopback.
Each request must name a verified `boss` or `orch` pane.
Send `x-herdr-env: 1`, `x-herdr-pane-id`, and `x-herdr-workspace-id`.
The existing caller-pane check verifies the pane ID, workspace, and label.
The read-only preview refuses these routes.

| GET route | Known result fields |
| --- | --- |
| `/api/process-facts/info?pid=PID` | `pid`, `alive`, `start`, `state`, `parents` |
| `/api/process-facts/port?port=PORT` | `listeners`, `clients`, `servicePid` |
| `/api/process-facts/cwd?path=PATH` | `processes` |

Each result has `known: true` or `known: false` with a safe `reason`.
Parent rows have `pid`, `ppid`, and `command`.
Port rows have `pid` and `command`.
The port lists contain listeners and established connections only.
The port route and client count each client PID once.
They exclude listener PIDs and the service PID from the client list.
The client also excludes its own PID.
Cwd rows have `pid`, `ppid`, `command`, and `inCwd`.
The cwd result includes the complete process tree with names and IDs only.
The `inCwd` field identifies each directory match.
This preserves worker attribution after the shell and its children change their directories.
It exposes no cwd path from another process.

The cwd path must be inside a registered project root, a configured worktree root, or the data directory.
Accept a repository worktree-root setting only when it resolves to an absolute path below the user home directory.
Refuse the home directory itself, a filesystem root, a relative path, and a symbolic link that escapes home.
Resolve symbolic links before the root check.
Refuse an outside path before the process probe.
Refuse other methods, invalid queries, and callers that cannot be verified.

The service runs the probes for each query under one two-second deadline.
Each probe uses only the time that remains.
It reads process names, IDs, states, start times, and cwd paths only.
It returns no arguments, environment, executable path, socket address, or file content.
The client projects each response onto these fields.
The synchronous client has a two-second HTTP limit.
It uses local probes only when the service cannot be reached.
A service refusal or an unknown service answer does not permit local fallback.
A timeout after connection gives an unknown answer with a timeout reason.
It does not permit local fallback.
Readers inside the service use local probes directly to avoid a request to the same service.

An unknown OpenCode lock owner stays held.
Worker collection records an unknown check and continues.
Worktree pruning keeps a worktree when its process check is unknown.
It continues the checks and cleanup for other worktrees.
Browser restart refuses an unknown client check and prints its exact override.
The override cannot bypass a known client or a command in flight.
