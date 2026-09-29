---
title: Hourly check
every: 60
model: cheap
---
Watch check. The Owner is away and the Boss acts for the Owner. Keep the check cheap.

1. Read the bulletin: rules now, quotas, load, allocation, locks, stale statuses, and notices.
2. Run `herdr agent list`. For each project orchestrator that is idle or done, has no worker running, and has ready tasks, read about 30 lines with `herdr agent read <pane> --source recent-unwrapped`. Nudge the orchestrator once, free models first.
3. Leave paused projects alone. Do not message a working orchestrator. Send no acknowledgements.
4. Run `herdr-boss check kit`. Nudge a project that is behind on a required kit change. Check that a stale lock or an idle lease does not block work.
5. Check that each orchestrator with a large context handed over at a task boundary.
6. Watch the quotas. If a lane is near its limit for the week, shift work to the other lanes and tell the orchestrators once.
7. If denials, stalls, or machine swap increase, look into the cause with a cheap read-only subagent.
8. Record each decision in the Boss memory file. If nothing needs action, end the check.
