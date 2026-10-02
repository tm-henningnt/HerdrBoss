# Git and worktree hygiene

Read this file before you dispatch work, stage or integrate a change, or clean up a worktree.

- The orchestrator owns Git topology and history.
- Inspect the branch, remotes, status, and diff before dispatching work.
- Preserve user-owned and unrelated changes.
- Use the project's branch naming convention.
- Give every active worker one named task, branch, worktree, and bounded scope. Give parallel changes separate branches and worktrees with independent scopes.
- Keep one writer per shared module. Serialize work when multiple tasks change the same shared module.
- Batch repeated work only when one mechanic truly applies across the batch. Name the allowed paths and acceptance commands for every batch.
- Inspect the full changed-path list before staging or integrating work.
- Do not narrow a commit so far that required new files are omitted.
- Do not switch a worker to another branch to make a check pass.
- Do not delete a worktree with unmerged or user-owned work.
- Do not use destructive reset, clean, force-push, or discard checkout as a shortcut.
- Record the verified commit or uncommitted state before the next task.
- Use `herdr-boss worktree prune` to review stale worktrees.
- Inspect prune candidates before applying cleanup.
- Use `herdr-boss worktree prune --apply` only after verifying the candidates and their ownership.
- Run a long gate in the foreground with `herdr-boss suite --wait 3600 -- <command>`. Set the command tool timeout to at least 3,600,000 ms. Do not run a long gate in a background shell with its default timeout. The `--wait` value is the maximum time to wait for the full-suite lock.
- Never take the full-suite lock with a bare lock acquire for a suite.
