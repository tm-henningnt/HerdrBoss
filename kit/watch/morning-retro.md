---
title: Morning retrospective
beforeEnd: 01:00
model: cheap
---
Morning retrospective. You may use `claude-haiku-5-5` for a bounded, read-only research subagent. The window is the time since the last retrospective. Save the results in the Boss scratch folder.

1. Harness and sandbox: list the classifier denials, sandbox denials, escalations, permission prompts, guard blocks, stalls, and refused collects. Group them by harness, cause, model, and project. Compare them with the earlier runs. Apply safe local configuration fixes and keep a backup of each changed file. Write the settings lines that only the Owner can apply into a file for the Owner. Queue kit changes for the Herdr Boss project.
2. Kit and Herdr Boss: check that they work as intended. Count the notices per pane per day and the kit revisions per day. Check the required-only notices, the kit update, the context handovers and their cleanup, the goal carry-over, the Watch feature, the lock waits and holds, and the manual workarounds that the projects repeat.
3. Efficiency: report the spend by role and harness, the subagent use, the worker watching, the review rounds, the docs-only push skips, and the serve-live use.
4. Model scorecard: report the quota rate per hour of each orchestrator model. Compare worker models on the same kind of task. Report first-time pass, rounds, minutes, and quota points when the records have them.

Return a summary of at most 500 words. Save the full result in a file named retro-<date>.md.
