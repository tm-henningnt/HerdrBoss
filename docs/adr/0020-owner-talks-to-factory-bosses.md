# ADR 0020: The Owner talks to each factory Boss; the head office is code

Status: Accepted. Owner decision, factories interview round 3, item `boss-contact`. The head office agent question was decided by the planner from the Owner's note.

## Context

The Owner expects to talk mainly to the factory Bosses, and sometimes perhaps to a head office Boss agent. The Owner was not sure that a head office agent is needed.

## Decision

- The Owner talks to each factory Boss directly through Herdr.
- The head office is code with no agent: the poller, the Fleet page, the combined Mailbox view, the factory share sliders, and the guidance sender.
- The head office Mailbox view links each item to its factory. The Owner answers in the factory.
- A head office Boss agent is a later option. It needs its own spec, because a chat with it implies a path that carries instructions into factories.

## Consequences

- No new path carries instructions into a factory. A taken head office can only change factory shares and post nudges (ADR 0011).
- The Owner switches between factories in the Herdr sidebar.

## Alternatives rejected

- Only the head office Boss, which relays to factory Bosses.
- One Boss at the head office with no factory Boss.
