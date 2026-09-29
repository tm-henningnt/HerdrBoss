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
