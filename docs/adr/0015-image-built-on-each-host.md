# ADR 0015: Each host builds its own factory image

Status: Accepted. Owner decision, factories interview round 2, item `registry`. Spec decision 6.

## Context

The factory image is about 1.5 GB (estimate). GitHub Free gives 500 MB of private package storage. The Dockerfile is in the public repository.

## Decision

Each host builds the factory image from the Dockerfile and `pins.json` with `factory build`. No registry is used.

## Consequences

- No registry account and no cost.
- Each host builds for its own CPU type. Multi-arch publishing is not needed.
- Two hosts can get different system package versions from the same pins. `factory status` shows the image build date and the pins hash, so the head office can show the drift.

## Alternatives rejected

- A public GHCR package.
- A private GHCR package with GitHub Team. A monthly cost, and 2 GB holds about one image version.
