# Review task rules

Read this file before you dispatch a reviewer or a review subagent.

## Waiting

- Put this rule in a review task brief: run a long command in the foreground, or wait for a background job with the tool that reports its end. Do not wait with `sleep` in a loop, and do not poll with `until` or `while` loops. To wait for a Herdr Boss run, use `herdr-boss wait`.

## Herdr Boss data

- Put this rule in a review task brief: run any command that reads Herdr Boss data with a temporary `HOME` and `HERDR_BOSS_DIR` (`mktemp -d`). Do not import modules of `src/` that open the live data directory.

## Review-pack values

- Use these item types in `manifest.json`: `image`, `image-pair`, `gallery`, `video`, `markdown`, `table`, `diff`, `file`, `link`, and `checklist`.
- Use these `ask` values to name each question: `accept`, `deny`, `note`, `live`, `choice`, and `rating`.
- Give each item that needs a decision both `accept` and `deny`, including `agent-verified` items. The Owner confirms or rejects the evidence. Herdr Boss adds the two values to an agent-verified item that lacks them, and `review check` warns.
- Give an item with only `note` in `ask` to show information. The Owner cannot decide it, so it never counts as open.
- Include light and dark images for a UI change, before and after images for a change, the exact text for a document, and a `link` item with `live` for each live check.
