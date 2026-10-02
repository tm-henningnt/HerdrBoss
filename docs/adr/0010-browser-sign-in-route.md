# ADR 0010: Build a browser sign-in route before the first container factory

Status: Accepted. Owner decision, factories interview round 1, item `browser`.

## Context

A container factory has a headless Chrome. No route exists for the Owner to sign in to a web app in it. Without one, Qlik and other browser-service features do not work in a container factory.

## Decision

Build a sign-in route before the first container factory. The Owner reaches the factory Chrome through the factory dashboard, signs in, and the profile stays on the `home` volume. The planner chooses the technique (ADR 0012).

## Consequences

- Chrome is in the first image set.
- One large task comes before the first factory.
- Browser and Qlik projects can move into container factories.

## Alternatives rejected

- Only projects without a signed-in browser in the first factories.
- A Chrome on the host over CDP. It breaks the container boundary.
