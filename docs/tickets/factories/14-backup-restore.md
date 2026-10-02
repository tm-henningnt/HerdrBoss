# 14: Backup, restore, destroy, and break glass

**What to build:** The Owner can back up, restore, and delete a factory, and repair one whose service is dead.

**Blocked by:** 09: Host tool core with the local transport.

**Status:** ready-for-agent

- [ ] `factory backup` stores the database with `VACUUM INTO`, the data files, and the `work` volume. With `home` included, the file is mode 0600 and outside every repository and cloud folder.
- [ ] `factory restore FILE` brings a factory back, and a restore test passes on a temporary factory.
- [ ] `factory destroy` needs a backup of the last 24 hours and a typed confirmation.
- [ ] `factory shell`, `logs`, `stop --now`, and `freeze` work with a dead service.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
