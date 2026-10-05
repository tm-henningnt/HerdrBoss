---
title: Hourly check
every: 60
model: cheap
---
Watch check. The Owner is away and the Boss acts for the Owner. Keep the check cheap.

1. Read the bulletin: rules now, quotas, load, allocation, locks, stale statuses, and notices.
2. Run `herdr-boss lock list`. Name each holder, its age, and each queued job before you nudge anyone. A stale lock or an idle lease that blocks no work needs no action.
3. Run `herdr agent list`. For each project orchestrator, read the idle age in the service snapshot in this prompt. Read about 30 lines with `herdr agent read <pane> --source recent-unwrapped`. Nudge the orchestrator once, free models first, and only when it is idle or done, has no worker running, has ready tasks, and the snapshot gives an age.
4. Leave paused projects alone. Do not message a working orchestrator. Never guess an age that the snapshot marks unknown, and never nudge a pane that is not idle or done. Send no acknowledgements.
5. Run `herdr-boss check kit`. Nudge a project that is behind on a required kit change.
6. Check that each orchestrator with a large context handed over at a task boundary.
7. Watch the quotas. If a lane is near its limit for the week, shift work to the other lanes and tell the orchestrators once.
8. If denials, stalls, or machine swap increase, look into the cause with a cheap read-only subagent.
9. Record each decision in the Boss memory file. If nothing needs action, end the check.
