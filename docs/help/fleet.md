# Fleet help

The head office reads each registered factory every 30 seconds. A factory outage keeps its last good summary and shows its age. The health cell becomes red and shows the reason. Last seen shows the last successful poll. Shared account quota uses the highest reading for each account and lane. It does not add repeated readings. Spend shows USD by day, role, and harness.

Use factory connect NAME on the host tool machine to connect a registered container factory. Run it again to resume. Use factory connect --check NAME for one check with name, state, and age only. The command reuses a matching Tailscale Serve forward. If Serve needs Owner rights, it prints the masked error and two Owner command choices, then exits 3. Run one choice in the WSL Owner terminal. The dashboard access rule stays in force.

Each Fleet Mailbox link opens the factory that owns the item. Answer there. Open Fleet settings to change the name, dashboard base URL, polling, title sharing, or account scopes. Credentials and account identities use private provisioning through the fleet command. They have no dashboard field.

Each remote factory row shows an Attach line. It reads attached or not attached. Attached means that Herdr on the Mac has an SSH machine for this factory. Select the copy button to copy `herdr-boss factory attach NAME`. Run the command in a Mac terminal. Run `herdr-boss factory attach NAME --undo` to detach. The page shows no address or key.
