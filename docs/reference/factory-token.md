# Factory dashboard token

Use this page for sign-in, token rotation, recovery, and the manual fallback.

## Sign in to a factory dashboard

Read the token only in an Owner terminal on the Mac. Do not use a Herdr pane.

1. Run `herdr-boss factory token NAME` in the Owner terminal.
2. Type the exact factory name when the command asks.
3. Select the printed token text in the terminal and copy it.
4. Open the factory dashboard. Paste the token into the sign-in form.

The command reads the configured `access.tokenFile` in the factory. It requires TTYs on stdin and stdout. It refuses `--json` and other output options. It has no clipboard option. Keep the token out of panes, chats, logs, and reports.

## Rotate the token

Run `herdr-boss factory token NAME --rotate` in the Owner terminal. Type the exact factory name. Run rotation only when the factory and dashboard service are running. Resume a paused factory first.

The command writes a new token with mode `0600` through a temporary file and rename. It removes the factory session file and restarts only `herdr-boss-serve`. It waits up to 30 seconds for the new service process and `/api/health`. It then prints the token once at the Owner terminal. Rotation signs out all devices.

The verified Boss pane may run the rotation command. It must also type the factory name. Its result shows only the factory name, the time, and `signed out all devices`. It receives no token. The Owner then runs `herdr-boss factory token NAME` in the Owner terminal. Other Herdr panes cannot use either command.

The command writes attempt and result audit lines in `factory-token-audit.jsonl`. This file is in `/home/factory/.config/herdr-boss` and has mode `0600`. The lines hold no token or token hash. If the attempt line cannot be written, the token stays unchanged. A process of the same user can already read the token file.

## Recover an incomplete token rotation

If the command stops after it writes the token, the new token is already in place. If the transport fails, the command cannot prove whether the write finished. The command prints no token in either case.

1. Run `herdr-boss factory shell NAME` in an Owner terminal.
2. In the factory shell, run `/command/s6-svc -r /run/service/herdr-boss-serve`.
3. Run `curl --retry 30 --retry-connrefused --retry-delay 1 --fail --silent --show-error --output /dev/null http://127.0.0.1:4477/api/health`.
4. Exit the factory shell.
5. Run `herdr-boss factory token NAME` in the Owner terminal.

Do not rotate again only to read the new token.

## Rotate the token by hand

Use this fallback only when the token command is unavailable. Run `herdr-boss factory shell NAME` in an Owner terminal. Replace both `NAME` values in the block with the factory name. If `access.tokenFile` is set, replace the `file` assignment with that path. Otherwise, the block writes `$HOME/.config/herdr-boss/access-token`.

Rotation signs out all devices. The block removes the session file and restarts only the factory dashboard service. It then checks health and prints the token in the Owner terminal.

```sh
(
set -eu
read -r -p 'Type NAME to confirm: ' confirm
test "$confirm" = "NAME"
token=$(openssl rand -hex 32)
file="$HOME/.config/herdr-boss/access-token"
tmp="$file.$$"
umask 077
printf '%s\n' "$token" > "$tmp"
mv "$tmp" "$file"
rm -f "$HOME/.config/herdr-boss/sessions.json"
/command/s6-svc -r /run/service/herdr-boss-serve
curl --retry 30 --retry-connrefused --retry-delay 1 --fail --silent --show-error --output /dev/null http://127.0.0.1:4477/api/health
printf '%s\n' "$token"
)
```

If the block stops after it writes the token, follow the recovery steps above. If the token command is still unavailable, read the configured token path in the Owner factory shell after the health check passes. Select the token text in the terminal and copy it.
