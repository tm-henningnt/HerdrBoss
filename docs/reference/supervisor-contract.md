# Supervisor contract

This contract lists the current lifecycle path for each supervisor.
The fake tests check local command behavior. They do not qualify a live host.

## launchd on macOS

- Install: Run `herdr-boss install`. `installService()` writes the plist, then runs `launchctl bootout` and `bootstrap` (`src/install.js:159-169`).
- Ready check: Run `herdr-boss doctor`. It runs `launchctl print gui/UID/no.tallmaker.herdr-boss` and accepts `state = running` (`src/doctor.js:136,278-280`).
- Restart: Run `launchctl kickstart -k gui/$(id -u)/no.tallmaker.herdr-boss` (`docs/cli.md:156-160`).
- Backup: gap. No native full-service backup command exists. SQLite backup covers only the database (`src/sqlite-store.js:338-345`; `docs/plans/arch1-study.md:149`).
- Rollback: gap. No native rollback command exists. The current CLI backup and restore commands cover container factories (`docs/cli.md:2033-2054`).

## systemd user service on Linux

- Install: Run `herdr-boss install`. `installService()` writes the unit, reloads systemd, enables the unit, and restarts it (`src/install.js:171-187`).
- Ready check: Run `herdr-boss doctor`. It runs `systemctl --user is-active herdr-boss.service` and accepts `active` (`src/doctor.js:136,278-280`).
- Restart: Run `systemctl --user restart herdr-boss.service` (`docs/cli.md:61-71`).
- Backup: gap. No native full-service backup command exists. SQLite backup covers only the database (`src/sqlite-store.js:338-345`).
- Rollback: gap. No native rollback command exists. The current CLI backup and restore commands cover container factories (`docs/cli.md:2033-2054`).

## s6 in the factory container

- Install: Run `herdr-boss factory new NAME`. The image installs s6-overlay and starts `/init`; `newFactory()` starts the container (`factory/Dockerfile:41-52,69-71,79-81`; `src/factory-core.js:236-284`).
- Ready check: `newFactory()` calls `readHealth()`. It checks `/api/health` and validates the health record (`src/factory-core.js:110-115,283-285`).
- Restart: Run `herdr-boss factory update NAME --tier service`. `updateService()` stops and starts `herdr-boss-serve` with `/command/s6-svc`, then waits for a clean health check (`src/factory-update.js:260-262,506-532`).
- Backup: Run `herdr-boss factory backup NAME --include-home`. `backup()` writes a private archive of the data, work, and home volumes (`src/factory-recovery.js:114-151`).
- Rollback: A failed service update returns to the prior commit. If the schema changed, repeat the update with `--accept-data-loss` to restore the private backup (`src/factory-update.js:443-463,506-553`; `docs/cli.md:2182-2184`).

Native installs back up only the SQLite database.
They have no tested full-service backup or rollback procedure (gap).
