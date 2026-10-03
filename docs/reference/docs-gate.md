# Docs gate

The docs gate checks that a change of behavior comes with a change of the docs. It stops a branch that changes behavior and changes no docs.

## Command

```sh
node scripts/docs-gate.js [--base <ref>] [--head <ref>] [--root <dir>] [--include-worktree]
```

The command compares `--head` (default `HEAD`) with the merge base of `--base` (default `main`) and `--head`. It prints the result.

| Option | Meaning |
|---|---|
| `--base <ref>` | The branch to compare with. The default is `main`. |
| `--head <ref>` | The tip to check. The default is `HEAD`. |
| `--root <dir>` | The Git repository to check. The default is the current folder. |
| `--include-worktree` | Also count files that are changed but not committed. |
| `--config <file>` | Use another rules file. |

| Exit code | Meaning |
|---|---|
| 0 | The gate passes. |
| 1 | The branch changes behavior, changes no docs, and has no exemption. |
| 2 | The command cannot compare, for example when the base does not exist. |

The gate passes on `main` with no branch diff, because the diff is empty.

## Path rules

The file `scripts/docs-gate.config.json` holds the rules. Each rule is a list of globs. `*` matches text inside one folder. `**` matches text across folders.

| Key | Meaning |
|---|---|
| `behavior` | A change to these paths changes behavior: `src/`, `public/`, `bin/`, `factory/`, and `kit/`. |
| `behaviorIgnore` | Paths that the `behavior` rule does not count: `kit/CHANGES.md`. |
| `docs` | A change to these paths is a docs change: `docs/` and `README.md`. The page help in `docs/help/` is part of `docs/`. |
| `docsIgnore` | Paths that the `docs` rule does not count: working records such as `docs/orchestration/`, `docs/plans/`, `docs/tickets/`, `docs/ideas/`, `docs/spikes/`, and the exemption file. |

A change to `test/`, `scripts/`, or `package.json` is not a behavior change.

## Exemption

Use an exemption for a change with no effect on behavior, for example a refactor or a typo. A reason is required. An exemption with no reason does not count.

1. Add the trailer `Docs-Exempt: <reason>` to the message of any commit of the branch.
2. Or add the line `<path glob> | <reason>` to `docs/gate-exemptions`. The entry exempts only the paths that match the glob.

The gate reads only the lines that the branch adds to `docs/gate-exemptions`. An entry from an earlier branch exempts nothing. Remove an old entry when you touch the file.

## Where the gate runs

- `npm test` runs `test/docs-gate.test.js`. The test runs the command on fixture repositories.
- The release steps in `AGENTS.md` run `node scripts/docs-gate.js --base main` in the integration worktree. The base `main` is the previous `main`.
- The kit tells each worker and each reviewer to apply the rule. See `kit/templates/worker-brief.md` and `kit/skills/herdr-orchestrator/reference/review-tasks.md`.
