# {{name}} agent instructions

Read [README.md](README.md) for the purpose of this project. Put product notes and plans in `docs/`.

## Roles

- The **Boss** runs in the pane labeled `boss` in the `Boss` workspace. It supervises all projects and talks to the Owner.
- The **orchestrator** runs in the pane labeled `orch` in the `{{slug}}` workspace. It develops this repository through workers.
- The orchestrator reports finished work and questions to the Boss pane with `herdr agent prompt <boss-pane> "..."`, without `--wait`.

## Safety rules

- This repository can become public. Before each commit, read the full diff for secrets, tokens, local file contents, and details from other projects.
- Never write a secret, token, key, or password into a file, a pane, or a report.
- A license is never inline. Do not ship a license, token, key text, or licensed state in a release, bundle, demo, fixture, or test app. Do this also for tests. Keep the license in the license extension that the Owner issues to the tenant, the carrier extension. A public verification key is allowed in code. A token is not allowed. Tests may create a throwaway key pair and sign tokens in memory at run time. Nothing signed or key-shaped is committed, shipped or written to a fixture file. A token-shaped string in a file that the docs gate scans fails the gate. The gate does not scan test/*.test.js, so the rule holds there without a check.
- Push only with `herdr-boss push`.
