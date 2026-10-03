# Fleet help

The head office reads each registered factory every 30 seconds. A factory outage keeps its last good summary and shows its age. The health cell becomes red and shows the reason. Last seen shows the last successful poll. Shared account quota uses the highest reading for each account and lane. It does not add repeated readings. Spend shows USD by day, role, and harness.

Use factory connect NAME on the host tool machine to connect a registered container factory. Run it again to resume. Use factory connect --check NAME for one check with name, state, and age only. The command reuses a matching Tailscale Serve forward. If Serve needs Owner rights, it prints the masked error and two Owner command choices, then exits 3. Run one choice in the WSL Owner terminal. The dashboard access rule stays in force.

Each Fleet Mailbox link opens the factory that owns the item. Answer there. Open Fleet settings to change the name, dashboard base URL, polling, title sharing, or account scopes. Credentials and account identities use private provisioning through the fleet command. They have no dashboard field.

## Factory shares

At the head office, set one slider for each factory in an account scope. Use whole percentages from 0 to 100. The shares of one account must total at most 100. Select Save factory shares. The plan saves before delivery. A pending factory keeps its last accepted share. The next successful poll retries delivery.

The factory share is a local pacing ceiling above the project allocation. Project shares stay in the local policy. At the ceiling, new workers for that account stop. Ignore quota mode and --force cannot bypass it. Each factory keeps its last accepted share when the head office is offline or the service restarts. Until the first guidance arrives, its profile ceiling is 100. Quota readings measure the shared account. They do not measure the use of one factory.

## Nudge a factory Boss

Open Nudge a factory Boss. Choose a factory in an account scope. Write a nudge of 1 to 500 characters. Select Send nudge. The nudge reaches the pane labeled boss as an agent message. If delivery is pending, select Send nudge again with the same text. A repeated nudge does not send twice at the same epoch. Secret masking applies before delivery and storage.

The guidance credential can set shares and send nudges only. It cannot change policy, start or stop workers, or read message text. The factory refuses guidance from an older head office epoch. A read-only preview refuses shares and nudges.

Send guidance credentials only over HTTPS. HTTP is permitted only for a loopback target. The sender refuses other HTTP targets before it sends the credential.

The factory refuses an epoch more than 1000 above its highest stored guidance or role epoch. To recover from an incorrect epoch or holder, rotate the guide credential at the receiving factory. Rotation resets both stored epochs and holders. It clears the nudge IDs of the old term and keeps the last accepted shares. Import the new credential at the head office through private provisioning.

If a fleet share file is invalid, the pacing view shows the problem and the service logs one warning. The local policy still loads with factory shares unset. A metered worker start refuses a failed share check. Unmetered worker starts do not read factory shares. Repair the fleet files to clear the problem.
