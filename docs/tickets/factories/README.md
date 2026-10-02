# Factories tickets

Tickets for the spec [`docs/specs/factories.md`](../../specs/factories.md). One file per ticket, in dependency order. Each ticket names the tickets that block it.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [Widen the product scope to the factory fleet](01-widen-product-scope.md) | none |
| 02 | [Spike: a factory in OrbStack on the Mac](02-spike-mac.md) | none |
| 03 | [Spike: the same steps on the Windows home server](03-spike-windows.md) | 02 |
| 04 | [Live data directory check and configurable roots](04-live-data-dir.md) | none |
| 05 | [Linux machine readers](05-linux-readers.md) | none |
| 06 | [Factory hostnames, health route, and log rotation](06-hosts-health-logs.md) | none |
| 07 | [Chrome path setting and browser sign-in view](07-browser-sign-in.md) | none |
| 08 | [The factory image](08-factory-image.md) | 02, 04, 05, 06 |
| 09 | [Host tool core with the local transport](09-host-tool-core.md) | 08 |
| 10 | [Factory wizard and harness login](10-wizard.md) | 09 |
| 11 | [The ssh transport and the Windows host runbook](11-ssh-transport.md) | 03, 09 |
| 12 | [The first personal factory on the Windows home server](12-first-windows-factory.md) | 07, 10, 11 |
| 13 | [Quota reads and account keys in a container factory](13-quota-in-containers.md) | 02, 08 |
| 14 | [Backup, restore, destroy, and break glass](14-backup-restore.md) | 09 |
| 15 | [Service and image updates](15-updates.md) | 14 |
| 16 | [Fleet summary and the read credential](16-fleet-summary.md) | 06, 13 |
| 17 | [Head office poller and Fleet page](17-head-office-fleet-page.md) | 16 |
| 18 | [Factory shares and guidance](18-shares-and-guidance.md) | 17 |
| 19 | [Head office role record and the move to Windows](19-head-office-role.md) | 12, 18 |
| 20 | [Project transfer, small form](20-project-transfer.md) | 12 |
| 21 | [Move factory zero into OrbStack on the Mac](21-factory-zero-in-orbstack.md) | 15, 19, 20 |
