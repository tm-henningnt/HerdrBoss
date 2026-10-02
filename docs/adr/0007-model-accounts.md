# ADR 0007: Model accounts for factories

Status: Accepted. Owner decision, factories interview round 1, item `accounts`. Spec decision 2.

## Context

All factories on one account share one quota pool. The subscription terms describe limits for ordinary, individual use.

## Decision

- Personal factories use the Owner's subscriptions, a few factories at a time.
- Each client factory uses separate accounts or API keys that the Owner owns.
- Now the Owner has one Claude subscription and one Codex subscription. All personal factories share them.
- The Owner has two OpenCode Go subscriptions. Each one belongs to one factory: one to the personal factory on the Mac, one to the factory on the home server.

## Consequences

- OpenCode moves into the first image set, because a factory-specific subscription is OpenCode.
- Claude and Codex quota is shared by factory zero and every personal container factory. Pacing must count all of them against one pool (ADR 0011).
- A client factory needs a new set of logins before its first run.

## Alternatives rejected

- The client owns the accounts. Possible later per contract, not the default.
- API keys for every factory. Higher cost for heavy use.
- The Owner's subscriptions for all factories, client factories included. Highest terms risk.
