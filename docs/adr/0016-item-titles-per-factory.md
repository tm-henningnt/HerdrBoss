# ADR 0016: Item titles reach the head office per factory

Status: Accepted. Owner decision, factories interview round 2, item `item-titles`. Spec decision 5.

## Decision

`fleet.shareItemTitles` is a setting of each factory. The `personal` profile sets it on. The `client` profile sets it off. The fleet summary carries item titles only when the setting is on. Message text never leaves a factory.

## Consequences

- The fleet view shows titles for personal work and counts for client work.
- The Owner can change the setting in the dashboard of each factory.

## Alternatives rejected

- Counts only for all factories.
- Titles for all factories. Client item titles are then stored at the head office.
