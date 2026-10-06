# Review task rules

Read this file before you dispatch a reviewer or a review subagent.

## Waiting

- Put this rule in a review task brief: run a long command in the foreground, or wait for a background job with the tool that reports its end. Do not wait with `sleep` in a loop, and do not poll with `until` or `while` loops. To wait for a Herdr Boss run, use `herdr-boss wait`.

## Herdr Boss data

- Put this rule in a review task brief: run any command that reads Herdr Boss data with a temporary `HOME` and `HERDR_BOSS_DIR` (`mktemp -d`). Do not import modules of `src/` that open the live data directory.

## Read-only worktree

- Put this rule in a review task brief: do not run `git stash`, `git reset`, or `git checkout` of any path or branch. Use `git show`, `git diff`, and `git log` only. A reviewer must not change the worktree that it reviews.

## Review inputs

- Give the review target to `worker start`, so the inputs land in the reviewer worktree.
- Use `--base BRANCH` for a committed branch. `worker start` copies the diff of `BRANCH` against the project base branch, and the changed file list, into `.worker/inputs/`.
- Use `--review-worktree PATH` with `--read-only` for an uncommitted target. `worker start` copies the tracked uncommitted changes from `HEAD` and `git status` of that worktree.
- Give `--base` or `--review-worktree`, not both.
- `worker start` refuses the whole review when a tracked changed path is a dotenv, credential, key, token, secret, or OpenCode config file, and names the path. The paths `.worker/` and `.orchestration/` stay in the review scope and do not refuse the copy. Remove the path, or copy safe files with `--copy`.
- The copied status can list an untracked file name. The copy never includes the content of an untracked file.
- Put this rule in a review task brief: read the copied review inputs under `.worker/inputs/`. Do not read another worktree.

## Docs check

- Put this rule in a review task brief: check that a change of behavior comes with a change of the docs and the page help in the same branch.
- Report a missing docs change as a finding. A change that has no docs change passes only with a recorded `Docs-Exempt: <reason>` trailer or exemption entry, and the reason must be true.
- Run the docs gate command of the project, when the project has one, and quote its result in the review.
- Do not merge a branch that fails the docs check. Send it back to the worker.

## License check

- Put this rule in a review task brief: a license is never inline. Report each release, bundle, demo, fixture, or test app that holds a license, token, key text, or licensed state. Report this also for tests. The Owner issues the license to the tenant in the carrier extension. A public verification key is allowed in code. A token is not allowed.
- A finding is enough. Do not ask for a license. The reviewer never receives one.

## Review-pack values

- Use these item types in `manifest.json`: `image`, `image-pair`, `gallery`, `video`, `markdown`, `table`, `diff`, `file`, `link`, and `checklist`.
- Use these `ask` values to name each question: `accept`, `deny`, `note`, `live`, `choice`, and `rating`.
- Give each item that needs a decision both `accept` and `deny`, including `agent-verified` items. The Owner confirms or rejects the evidence. Herdr Boss adds the two values to an agent-verified item that lacks them, and `review check` warns.
- Give an item with only `note` in `ask` to show information. The Owner cannot decide it, so it never counts as open.
- Include light and dark images for a UI change, before and after images for a change, the exact text for a document, and a `link` item with `live` for each live check.
- Keep license text, a license token, and a licensed state out of every item. A demo or a fixture shows a public verification key.
