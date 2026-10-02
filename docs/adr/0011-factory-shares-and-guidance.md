# ADR 0011: Factory shares of a shared account, and guidance from the head office

Status: Accepted. Owner decision, factories interview round 2, item `quota-split`, with the Owner's note. Design details decided by the planner.

## Context

Two or more factories use one Claude subscription and one Codex subscription (ADR 0007). Each factory paces only against its own projects. Quota rows carry no account identity (`src/collect.js`). Policy shares exist per project only (`src/control.js:272-280`).

## Decision

- Each harness account has an **account scope**: the factories that may use it. An OpenCode Go subscription can have a scope of one or two factories.
- The head office shows one allocation slider per factory for each shared account, as the dashboard does per project today. The value is the **factory share** of that account, from 0 to 100. The shares of one account total at most 100.
- Each factory reads the usage of its own accounts with the CodexBar CLI or an equal Linux reader. The spike confirms the Linux reader.
- Each factory enforces its factory share locally. It keeps the last share when the head office is offline. A new factory starts with the share of its profile.
- The head office sends **guidance** to the Boss of each factory: factory shares and nudge messages, as Herdr Boss nudges orchestrators today.
- Guidance uses a narrow credential, `fleetGuide`. It can set factory shares and post a nudge to the factory Boss. It cannot change policy, start or stop workers, or read message text.
- Quota rows get an `accountKey`: an HMAC of the account identity, never the identity.

## Consequences

- A factory Boss runs in each factory.
- The fleet summary carries the usage per `accountKey`, so the head office can show one pool per account.
- A head office with the `fleetGuide` credential can lower the work rate of a factory. It cannot read or change its work.

## Alternatives rejected

- Container factories use only OpenCode Go until the head office divides the pool.
- No ceiling. A busy factory can use up the pool of the others.
- A full write credential for the head office. It reaches every factory.
