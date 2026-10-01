# Review task rules

Read this file before you dispatch a reviewer or a review subagent.

## Waiting

- Put this rule in a review task brief: run a long command in the foreground, or wait for a background job with the tool that reports its end. Do not wait with `sleep` in a loop, and do not poll with `until` or `while` loops. To wait for a Herdr Boss run, use `herdr-boss wait`.

## Herdr Boss data

- Put this rule in a review task brief: run any command that reads Herdr Boss data with a temporary `HOME` and `HERDR_BOSS_DIR` (`mktemp -d`). Do not import modules of `src/` that open the live data directory.
