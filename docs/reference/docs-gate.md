# Docs gate

The docs gate checks that a change of behavior comes with a change of the docs. It stops a branch that changes behavior and changes no docs.

The gate also checks the shipped artifacts of the branch. It stops a branch whose artifact holds a token-shaped string, for example a license token.

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
| 1 | The branch changes behavior and changes no docs and has no exemption, or a shipped artifact holds a token-shaped string. |
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

## Token check

A license is never inline. A release, a bundle, a demo, a fixture, or a test app holds no license text, no license token, no key text, and no licensed state. The check reads each changed artifact in the `tokens` globs and stops the branch on a token-shaped string. The check reads every line of a file. With `--include-worktree`, the check reads the working tree content of an uncommitted file. A unit test file is not a shipped artifact, so the gate does not scan `test/*.test.js`. Binary files, such as archives, are not scanned.

The `tokens` key in `scripts/docs-gate.config.json` holds the globs. They cover `src/`, `kit/`, `scripts/`, `examples/`, the files in the repository root, `public/`, `bin/`, `factory/`, `release/`, `releases/`, `dist/`, `build/`, `demo/`, `demos/`, `fixture/`, `fixtures/`, `test-app/`, `test-apps/`, and the artifact folders `test/fixtures/`, `test/apps/`, and `test/demos/`.

| Token class | Meaning |
|---|---|
| `jwt` | A token with three base64url parts, where the first part starts with `eyJ`. |
| `PEM private key block` | A `-----BEGIN ... PRIVATE KEY-----` line. |
| `license blob` | A long base64 value after a key name that holds `license` or `token`, in snake, kebab, camel, or upper case, for example `license_key`, `LICENSE_KEY`, `licenseToken`, `access_token`, or `license-key`. The value can be on the line after the key, as in YAML. |

Two things stay allowed:

- A public verification key. A line with a `PUBLIC KEY` or a `CERTIFICATE` block gives no finding.
- A fake test string. Put the allow marker on the same line as the string: `herdr-boss: allow-test-token`.

A finding names the file and the class. The gate never prints the value that it found.

## Exemption

Use an exemption for a change with no effect on behavior, for example a refactor or a typo. A reason is required. An exemption with no reason does not count.

1. Add the trailer `Docs-Exempt: <reason>` to the message of any commit of the branch.
2. Or add the line `<path glob> | <reason>` to `docs/gate-exemptions`. The entry exempts only the paths that match the glob.

The gate reads only the lines that the branch adds to `docs/gate-exemptions`. An entry from an earlier branch exempts nothing. Remove an old entry when you touch the file.

## Where the gate runs

- `npm test` runs `test/docs-gate.test.js` and `test/docs-gate-tokens.test.js`. The tests run the command on fixture repositories.
- The release steps in `AGENTS.md` run `node scripts/docs-gate.js --base main` in the integration worktree. The base `main` is the previous `main`.
- The kit tells each worker and each reviewer to apply the rule. See `kit/templates/worker-brief.md` and `kit/skills/herdr-orchestrator/reference/review-tasks.md`.
