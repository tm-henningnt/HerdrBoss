# Kit change log

This file is the fallback record of kit changes. A commit that changes kit
assets can carry a `Kit-Impact:` trailer instead. The notice code reads both
sources to classify each change.

## Format

Each entry starts with a level-two heading that holds the kit revision that
the change produced. The entry has an `Impact:` line and a `Summary:` line.

    ## <revision>
    Impact: <required|useful|none>
    Summary: <one line>

Entries are chronological. The oldest entry is first. A project whose kit
revision matches an entry has that entry and every earlier entry.

## Entries

## 883095fbe869
Impact: required
Summary: Compute the kit revision from installed kit assets only.

## d5a3318be296
Impact: useful
Summary: Add gpt-6.1-sol as the trial Codex model for tougher tasks; gpt-6-luna stays the routine default; remove gpt-6-sol.

## 51683b8cf0ee
Impact: useful
Summary: Add editable Watch routine texts (kit/watch) that the service runs during a watch.

## 9ca9a9ebf4a8
Impact: useful
Summary: Carry the Owner /goal over in an orchestrator handover.

## 4f7a0c699512
Impact: useful
Summary: Add a blocking herdr-boss wait for the few cases that must block.

## 60049d639ff0
Impact: useful
Summary: Tell orchestrators to start workers with --task-id so the board shows live task state.

## c13020178b65
Impact: required
Summary: Add the subagent and no-watching rule (subagents for reviews and reads, end the turn after a dispatch, at most one check every 20 to 30 minutes); a Kit updated notice now means run kit update and continue.

## 7436456f91aa
Impact: useful
Summary: Publish the project status at task boundaries only; the service keeps the last 30 done tasks and counts the rest.

## f73a93f04e11
Impact: useful
Summary: GUI worker briefs say that seed data goes only into a temporary HERDR_BOSS_DIR, and that the preview runs read-only on its own port.

## 084656db38fb
Impact: useful
Summary: Worker briefs address the orchestrator by its stable agent name, and a handover tells each running worker the new orchestrator.

## b966d46c47d7
Impact: useful
Summary: Add the AGENTS.md project part and README templates for the new project flow.

## 87289067cf70
Impact: useful
Summary: A lane is ahead of pace only above a tolerance (default 5 points) and a minimum use (default 30%); the lanes line shows the tolerance.

## fdcccc24dac7
Impact: useful
Summary: Add herdr-boss gh label create|list|edit|sync and gh milestone create|list, the triage label preset, and the triage-labels template; project new sets the triage labels on a private GitHub repository.

## 17e04d97cd66
Impact: useful
Summary: Serve-port leases end when the bound server process ends or the port has no listener for 20 minutes; lease acquire takes --pid, --wait, and --env-file, lease bind binds a server, and a pool can hand a client ID by port.

## e4591d0a3d3d
Impact: useful
Summary: Add the review pack section to the orchestrator skill and the worker brief template.

## 315d28e0a176
Impact: useful
Summary: The worker brief forbids sleep loops and until or while polling and names herdr-boss wait; the orchestrator skill sends a reviewer the same rule and a temporary HOME and HERDR_BOSS_DIR.

## 1b34ccad1bca
Impact: useful
Summary: A serve-live server binds its PID to its lease at start with lease bind, so Herdr Boss can tell its port from an unleased listener.

## 60d55aa14e84
Impact: useful
Summary: Add the picture line to the orchestrator skill and the project kit: send a picture with herdr-boss say --image, and read an Owner Attachment path with the image tool.

## 2ce7a7451a5e
Impact: useful
Summary: Keep the Boss reporting rule and send reports with herdr-boss tell.

## 0d84a561a0cf
Impact: useful
Summary: Codex workers attach the Chrome DevTools MCP to the project browser. The worker brief gets rules for browser tasks: own tab only, close the tab, no cookies, storage, or tokens.

## 3ffd68a69e47
Impact: required
Summary: Add CI minute rules and GitHub workflow templates; create and copy missing project workflows.

## 2db88201b003
Impact: useful
Summary: Use default worker collection recording in kit and command documentation.

## 2ac9048be57b
Impact: useful
Summary: Wait for browser commands and CDP clients before restart. Restore saved tabs in separate windows and read their new IDs.
