# Factory dashboard token command

## Goal

Add `herdr-boss factory token NAME [--rotate]` for a container factory dashboard.

## Command rules

- Without `--rotate`, read the active token from the configured `access.tokenFile`.
  The default is `/home/factory/.config/herdr-boss/access-token`.
- Print the token once only at the Owner terminal.
- Require TTYs for stdin and stdout. Refuse `--json` and other output formats.
- Before the command reads, prints, or changes a token, ask the Owner to type the exact factory name.
- Reuse `verifyNightCaller` for a Boss pane. Refuse every other pane.
- Treat a plain shell with no Herdr variables as the Owner terminal.
- The Boss may run `factory token NAME --rotate`, but the command must suppress the token.
  Print only the factory name, the time, and `signed out all devices`.
- After a Boss rotation, the Owner reads the new token with the no-rotate command at an Owner terminal.
- The Boss may not read a token without `--rotate`.
- The Owner may read a token with or without `--rotate` at the Owner terminal.
- Do not add a clipboard command. The Owner reads the token at the Owner terminal.
- Keep the token out of arguments, environment variables, errors, logs, audit lines, panes, and reports.

The caller check prevents accidents and pane leaks. It does not stop a hostile process of the same user, which can already read the token file.

## Rotation

Read the configured `access.tokenFile` path. The default is `/home/factory/.config/herdr-boss/access-token`.
Generate 32 random bytes in the factory and encode them as hex.
Write the new token to a temporary file in the same directory with mode `0600`, then rename it over the token file.
Remove `/home/factory/.config/herdr-boss/sessions.json`.

The session file stores hashes of session IDs and a hash of the token.
`loadSessions` accepts sessions only when the stored token hash matches the active token hash.
The server loads the token and sessions into memory when it starts.
Restart only `herdr-boss-serve` after rotation.
Use `/command/s6-svc -r /run/service/herdr-boss-serve` in the container.
Wait for `/api/health` before returning the token to the Owner.
Do not restart the container, other services, or other factories.

Append token-free audit lines to `/home/factory/.config/herdr-boss/factory-token-audit.jsonl`.
Set the file mode to `0600`.
Each line has the time, factory name, action, caller role, and result.
Write an attempt line before rotation and a result line after the health check.
Do not write the token or its hash.
Stop before changing files if the attempt line cannot be written.

## Files to change

- `src/cli.js`: add help text and check the caller, TTYs, and typed factory name.
- `src/factory-host.js`: route the token action through the factory host command.
- `src/factory-token.js`: add token read, atomic rotation, session removal, audit, restart, and health check.
- `test/factory-token.test.js`: cover the command and its failure paths with temporary data and a fake factory transport.
- `test/factory-host.test.js`: cover argument parsing and caller refusal.
- `docs/cli.md`: document the command, its confirmation, and its terminal rules.
- `docs/guide/factory.md` and `docs/help/fleet.md`: document sign-in and manual rotation.

## Tests to write

- Refuse when stdin or stdout is not a TTY, or when options are invalid. Make no factory call.
- Allow only the Owner terminal or verified Boss pane. Require the exact factory name before token access or rotation.
- Print one token line for the Owner and no token for a Boss rotation.
- Verify that a Boss rotation prints only the factory name, time, and `signed out all devices`.
- Write the token atomically with mode `0600` and remove the session file.
- Verify the service restart and health check. Do not restart the container.
- Verify that audit lines contain no token or token hash.
- Verify that errors, logs, audit lines, and reports contain no token.
- Use temporary `HOME` and `HERDR_BOSS_DIR` values in every test.

## Open questions

- Should rotation refuse a factory whose service is already unhealthy, or try to recover it?
- What retention limit should apply to `factory-token-audit.jsonl`?

## Risks

- The Owner terminal scrollback can retain a printed token.
- A literal token typed into a shell command can enter shell history.
- A failed restart can leave a new token file while the old service process still runs.
- A same-user process can read the token file, even when caller checks pass.
- A custom `access.tokenFile` path can be missed if rotation uses only the default path.

## Source checks

- `src/config.js:14-15,142` defines the default token and session paths. `src/access.js:16-32,55-67` ties saved sessions to the token hash.
- `src/factory-recovery.js:275-303` runs factory shell commands and masks output.
- `src/cli.js:122-150` defines the Owner and Boss caller check.
- `docs/reference/service.md:105-108` documents the session lifetime and token rotation effect.
