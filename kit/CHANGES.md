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
