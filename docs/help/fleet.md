# Fleet help

The head office reads each registered factory every 30 seconds. A factory outage keeps its last good summary and shows its age. The health cell becomes red and shows the reason. Last seen shows the last successful poll. Shared account quota uses the highest reading for each account and lane. It does not add repeated readings. Spend shows USD by day, role, and harness.

Use factory connect NAME on the host tool machine to connect a registered container factory. Run it again to resume. Use factory connect --check NAME for one check with name, state, and age only. The command reuses a matching Tailscale Serve forward. If Serve needs Owner rights, it prints the masked error and two Owner command choices, then exits 3. Run one choice in the WSL Owner terminal. The dashboard access rule stays in force.

Each Fleet Mailbox link opens the factory that owns the item. Answer there. Open Fleet settings to change the name, dashboard base URL, polling, title sharing, or account scopes. Credentials and account identities use private provisioning through the fleet command. They have no dashboard field.

Each remote factory row shows an Attach line. It reads attached or not attached. Attached means that Herdr on the Mac has an SSH machine for this factory. Select the copy button to copy `herdr-boss factory attach NAME`. Run the command in a Mac terminal. Run `herdr-boss factory attach NAME --undo` to detach. The page shows no address or key.
Run factory login NAME claude or factory login NAME codex in an Owner terminal. The command checks login and prepares the first-run state. It trusts the Boss folder and registered project folders. It keeps other settings and credential files. Run factory boss start NAME to start the Boss. That command also prepares the first-run state before a start. If a startup dialog remains, the error names the dialog and pane ID. It includes masked pane text and prompt errors. Inspect that pane before you retry.

## Factory shares

At the head office, set one slider for each factory in an account scope. Use whole percentages from 0 to 100. The shares of one account must total at most 100. Select Save factory shares. The plan saves before delivery. A pending factory keeps its last accepted share. The next successful poll retries delivery.

The factory share is a local pacing ceiling above the project allocation. Project shares stay in the local policy. At the ceiling, new workers for that account stop. Ignore quota mode and --force cannot bypass it. Each factory keeps its last accepted share when the head office is offline or the service restarts. Until the first guidance arrives, its profile ceiling is 100. Quota readings measure the shared account. They do not measure the use of one factory.

## Nudge a factory Boss

Open Nudge a factory Boss. Choose a factory in an account scope. Write a nudge of 1 to 500 characters. Select Send nudge. The nudge reaches the pane labeled boss as an agent message. If delivery is pending, select Send nudge again with the same text. A repeated nudge does not send twice at the same epoch. Secret masking applies before delivery and storage.

The guidance credential can set shares and send nudges only. It cannot change policy, start or stop workers, or read message text. The factory refuses guidance from an older head office epoch. A read-only preview refuses shares and nudges.

Send guidance credentials only over HTTPS. HTTP is permitted only for a loopback target. The sender refuses other HTTP targets before it sends the credential.

The factory refuses an epoch more than 1000 above its highest stored guidance or role epoch. To recover from an incorrect epoch or holder, rotate the guide credential at the receiving factory. Rotation resets both stored epochs and holders, except on the factory that holds the head office role. It clears the nudge IDs of the old term and keeps the last accepted shares. Import the new credential at the head office through private provisioning.

If a fleet share file is invalid, the pacing view shows the problem and the service logs one warning. The local policy still loads with factory shares unset. A metered worker start refuses a failed share check. Unmetered worker starts do not read factory shares. Repair the fleet files to clear the problem.

## Head office role

The Head office panel shows the factory that holds the head office role and the epoch of its term. Only the holder polls the other factories and sends factory shares and nudges. A factory that sees a higher epoch stops both.

The panel also lists a factory that was never told of a move. Turn off head office polling on that factory. Keep head office polling off on every factory until it takes the role. A factory with polling on and no role record counts as the holder.

Move the role on the factory that takes it. Run `herdr-boss hub promote` in an Owner terminal. The command refuses when a registered factory cannot be reached. Run it with `--force` to continue without that factory. The new holder gets the factory list and the factory shares from the former holder, or keeps its own copy. It never receives host addresses. A factory on an unknown host stays out of its registry. See the move runbook in the factory chapter of the user guide.
